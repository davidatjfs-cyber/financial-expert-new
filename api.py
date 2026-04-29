"""
FastAPI backend for the Financial Analyzer frontend.
Run with: uvicorn api:app --reload --port 8000
"""
from __future__ import annotations

import json
import multiprocessing
import os
import re
import threading
import time
import html
from io import BytesIO
from pathlib import Path
import datetime as _dt
from datetime import date
from typing import Optional
from zoneinfo import ZoneInfo as _ZoneInfo
from urllib.parse import unquote, urljoin, urlparse, parse_qs
import numpy as np
import pandas as pd
import requests

from fastapi import FastAPI, HTTPException, UploadFile, File, Form, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel
from sqlalchemy import delete, func, select

from core.db import session_scope
from core.models import (
    Alert,
    Company,
    ComputedMetric,
    PortfolioAutoTrade,
    PortfolioPosition,
    PortfolioTrade,
    Report,
    Statement,
    StatementItem,
)
from core.repository import (
    list_reports,
    get_report,
    normalize_market,
    upsert_company,
    delete_report_children,
    upsert_report_market_fetch,
    upsert_report_file_upload,
)
from core.schema import init_db
from core.uploads import save_uploaded_file, save_uploaded_file_stream
from core.pipeline import ingest_and_analyze_market_fetch
from core.stock_search import normalize_symbol
from core.net import disable_proxies_for_process

# Initialize database
init_db()


_MAX_UPLOAD_BYTES = int((os.environ.get("MAX_UPLOAD_MB") or "30").strip() or "30") * 1024 * 1024
_PDF_ANALYSIS_SEM = threading.Semaphore(int((os.environ.get("PDF_ANALYSIS_CONCURRENCY") or "1").strip() or "1"))

_SPOT_CACHE: dict[str, tuple[float, "pd.DataFrame"]] = {}

# If yfinance is rate-limited for US symbols, skip yfinance for a short cooldown window.
_YF_US_COOLDOWN_UNTIL: float = 0.0


def _latest_closed_trade_date_us(now_ny: _dt.datetime | None = None) -> date:
    """Return the latest *closed* US trading date (weekday-only approximation)."""
    ny = now_ny or _dt.datetime.now(_ZoneInfo("America/New_York"))
    d = ny.date()

    # Weekend: roll back to Friday.
    if d.weekday() >= 5:
        d = d - _dt.timedelta(days=(d.weekday() - 4))
        return d

    # Weekday before close (16:00 NY): current day's bar is still forming.
    if ny.time() < _dt.time(16, 0):
        d = d - _dt.timedelta(days=1)
        while d.weekday() >= 5:
            d = d - _dt.timedelta(days=1)
    return d


def _pdf_extract_worker(
    conn,
    path: str,
    use_ai: bool,
    force_ai: bool,
    max_mem_mb: int,
    cpu_seconds: int,
):
    """Worker for PDF extraction in a subprocess.

    Must be module-level to support multiprocessing 'spawn' start method.
    """
    try:
        try:
            import resource

            if max_mem_mb and max_mem_mb > 0:
                limit_bytes = int(max_mem_mb) * 1024 * 1024
                resource.setrlimit(resource.RLIMIT_AS, (limit_bytes, limit_bytes))
            if cpu_seconds and cpu_seconds > 0:
                resource.setrlimit(resource.RLIMIT_CPU, (int(cpu_seconds), int(cpu_seconds)))
        except Exception:
            pass

        try:
            disable_proxies_for_process()
        except Exception:
            pass

        from core.pdf_analyzer import extract_financials_from_pdf

        res = extract_financials_from_pdf(path, use_ai=use_ai, force_ai=force_ai)
        try:
            conn.send({"ok": True, "data": res})
        except Exception:
            pass
    except Exception as e:
        try:
            import traceback

            msg = str(e) if e is not None else ""
            if not msg:
                msg = f"{type(e).__name__}"
            tb = traceback.format_exc(limit=50)
            conn.send({"ok": False, "error": msg, "traceback": tb})
        except Exception:
            pass
    finally:
        try:
            conn.close()
        except Exception:
            pass

app = FastAPI(title="Financial Analyzer API", version="1.0.0")


@app.get("/api/version")
def api_version():
    rev = None
    try:
        p = Path("/app/.app_rev")
        if p.exists():
            rev = p.read_text(encoding="utf-8").strip() or None
    except Exception:
        rev = None

    return {
        "app_rev": rev,
        "force_pdf_ai": (os.environ.get("FORCE_PDF_AI") or "").strip(),
        "enable_ocr": (os.environ.get("ENABLE_OCR") or "").strip(),
        "auto_ocr_fallback": (os.environ.get("AUTO_OCR_FALLBACK") or "").strip(),
    }

# CORS middleware for Next.js frontend
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://192.168.71.102:3000", "*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ============ Pydantic Models ============

class StatsResponse(BaseModel):
    total: int
    done: int
    risks: int
    rate: int


class ReportResponse(BaseModel):
    id: str
    report_name: str
    source_type: str
    period_type: str
    period_end: str
    status: str
    created_at: int
    updated_at: int
    company_id: Optional[str] = None


class CompanyHistoryResponse(BaseModel):
    company_name: str
    website: Optional[str] = None
    source_url: Optional[str] = None
    history_text: str = ""


class ReportDetailResponse(BaseModel):
    id: str
    report_name: str
    source_type: str
    period_type: str
    period_end: str
    status: str
    error_message: Optional[str]
    created_at: int
    updated_at: int
    company_id: Optional[str]
    market: Optional[str]
    industry_code: Optional[str] = None


class MetricResponse(BaseModel):
    metric_code: str
    metric_name: str
    value: Optional[float]
    unit: Optional[str]
    period_end: str


class AlertResponse(BaseModel):
    id: str
    alert_code: str
    level: str
    title: str
    message: str
    period_end: str


class StockSearchResult(BaseModel):
    symbol: str
    name: str
    market: str


class PortfolioPositionResponse(BaseModel):
    id: str
    market: str
    symbol: str
    name: Optional[str] = None
    quantity: float
    avg_cost: float
    target_buy_price: Optional[float] = None
    target_sell_price: Optional[float] = None
    current_price: Optional[float] = None
    market_value: Optional[float] = None
    unrealized_pnl: Optional[float] = None
    unrealized_pnl_pct: Optional[float] = None
    strategy_buy_price: Optional[float] = None
    strategy_buy_ok: Optional[bool] = None
    strategy_buy_reason: Optional[str] = None
    strategy_buy_desc: Optional[str] = None
    strategy_sell_price: Optional[float] = None
    strategy_sell_ok: Optional[bool] = None
    strategy_sell_reason: Optional[str] = None
    strategy_sell_desc: Optional[str] = None
    updated_at: int


class PortfolioCreatePositionRequest(BaseModel):
    market: str
    symbol: str
    name: Optional[str] = None
    target_buy_price: Optional[float] = None
    target_sell_price: Optional[float] = None


class PortfolioUpdatePositionRequest(BaseModel):
    name: Optional[str] = None
    target_buy_price: Optional[float] = None
    target_sell_price: Optional[float] = None


class PortfolioTradeRequest(BaseModel):
    position_id: str
    side: str  # BUY / SELL
    quantity: float


class PortfolioTradeResponse(BaseModel):
    id: str
    position_id: str
    side: str
    price: float
    quantity: float
    amount: float
    created_at: int


class PortfolioAutoTradeRequest(BaseModel):
    position_id: str
    side: str  # BUY / SELL
    trigger_price: float
    quantity: float


class PortfolioAutoTradeResponse(BaseModel):
    id: str
    position_id: str
    side: str
    trigger_price: float
    quantity: float
    status: str
    created_at: int
    executed_at: Optional[int] = None
    executed_price: Optional[float] = None
    symbol: Optional[str] = None
    name: Optional[str] = None
    market: Optional[str] = None


class PortfolioAlertResponse(BaseModel):
    key: str
    position_id: str
    market: str
    symbol: str
    name: Optional[str] = None
    alert_type: str
    message: str
    current_price: Optional[float] = None
    trigger_price: Optional[float] = None


class CreateReportRequest(BaseModel):
    company_name: str
    period_type: str
    period_end: str


# ============ API Endpoints ============

@app.get("/")
def root():
    return {"message": "Financial Analyzer API", "version": "1.0.0"}


@app.get("/api/stats", response_model=StatsResponse)
def get_stats():
    """Get dashboard statistics."""
    with session_scope() as s:
        total = s.execute(select(func.count(Report.id))).scalar() or 0
        done = s.execute(select(func.count(Report.id)).where(Report.status == "done")).scalar() or 0
        risks = s.execute(select(func.count(func.distinct(Alert.report_id))).where(Alert.level == "high")).scalar() or 0
        rate = int(done / total * 100) if total > 0 else 0
    return StatsResponse(total=total, done=done, risks=risks, rate=rate)


@app.get("/api/reports", response_model=list[ReportResponse])
def get_reports(limit: int = 50, status: Optional[str] = None):
    """Get list of reports."""
    def _decode_report_name(name: str) -> str:
        try:
            if name and "%" in name:
                return unquote(name)
        except Exception:
            pass
        return name

    reports = list_reports(limit=limit)
    if status:
        reports = [r for r in reports if r.status == status]
    return [
        ReportResponse(
            id=r.id,
            report_name=_decode_report_name(r.report_name),
            source_type=r.source_type,
            period_type=r.period_type,
            period_end=r.period_end,
            status=r.status,
            created_at=getattr(r, "created_at", r.updated_at),
            updated_at=r.updated_at,
            company_id=getattr(r, "company_id", None),
        )
        for r in reports
    ]


@app.get("/api/reports/{report_id}", response_model=ReportDetailResponse)
def get_report_detail(report_id: str):
    """Get report details."""
    report = get_report(report_id)
    if not report:
        raise HTTPException(status_code=404, detail="Report not found")

    report_name = report.report_name
    try:
        if report_name and "%" in report_name:
            report_name = unquote(report_name)
    except Exception:
        pass

    industry_code = None
    try:
        if report.company_id:
            with session_scope() as s:
                c = s.get(Company, report.company_id)
                if c and c.industry_code:
                    industry_code = c.industry_code
    except Exception:
        industry_code = None

    return ReportDetailResponse(
        id=report.id,
        report_name=report_name,
        source_type=report.source_type,
        period_type=report.period_type,
        period_end=report.period_end,
        status=report.status,
        error_message=report.error_message,
        created_at=report.created_at,
        updated_at=report.updated_at,
        company_id=report.company_id,
        market=report.market,
        industry_code=industry_code,
    )


_COMPANY_HISTORY_CACHE: dict[str, tuple[float, dict]] = {}
_COMPANY_HISTORY_CACHE_TTL = 12 * 3600


def _extract_text_from_html(raw_html: str) -> str:
    if not raw_html:
        return ""
    text = raw_html
    if text.startswith("\ufeff"):
        text = text[1:]
    text = text.lstrip("\ufeff")
    text = re.sub(r"(?is)<script[^>]*>.*?</script>", " ", text)
    text = re.sub(r"(?is)<style[^>]*>.*?</style>", " ", text)
    text = re.sub(r"(?is)<noscript[^>]*>.*?</noscript>", " ", text)
    text = re.sub(r"(?is)<[^>]+>", " ", text)
    text = html.unescape(text)
    text = re.sub(r"\s+", " ", text).strip()
    return text


def _score_history_text(text: str) -> int:
    if not text:
        return 0
    kws = ["发展历程", "历史", "里程碑", "成立", "创立", "上市", "改制", "history", "founded", "milestone"]
    score = 0
    for kw in kws:
        score += text.lower().count(kw.lower()) * 10
    score += min(len(text) // 50, 200)
    return score


def _extract_links(base_url: str, raw_html: str) -> list[str]:
    hrefs = re.findall(r"(?is)href\s*=\s*['\"]([^'\"]+)['\"]", raw_html or "")
    out: list[str] = []
    base_netloc = urlparse(base_url).netloc
    for href in hrefs:
        if not href or href.startswith("#") or href.startswith("javascript:"):
            continue
        u = urljoin(base_url, href.strip())
        pu = urlparse(u)
        if pu.scheme not in ("http", "https"):
            continue
        if base_netloc and pu.netloc and pu.netloc != base_netloc:
            continue
        out.append(u)
    uniq: list[str] = []
    seen: set[str] = set()
    for u in out:
        if u not in seen:
            seen.add(u)
            uniq.append(u)
    return uniq


def _find_official_website(report: Report, company_name: str) -> Optional[str]:
    market = (report.market or "").upper()
    symbol = ""
    if report.company_id and ":" in report.company_id:
        symbol = report.company_id.split(":", 1)[1]

    try:
        meta = json.loads(report.source_meta or "{}") if report.source_meta else {}
        for k in ("website", "official_website", "company_website", "url"):
            v = (meta.get(k) or "").strip() if isinstance(meta, dict) else ""
            if v.startswith("http"):
                return v
    except Exception:
        pass

    # CN profile may contain official website field.
    if market == "CN" and symbol:
        try:
            import akshare as ak

            df = ak.stock_individual_info_em(symbol=symbol[:6])
            if df is not None and not df.empty:
                for _, row in df.iterrows():
                    item = str(row.get("item") or row.get("项目") or "")
                    val = str(row.get("value") or row.get("值") or "").strip()
                    if any(x in item for x in ["官网", "网站"]) and val.startswith("http"):
                        return val
        except Exception:
            pass

    # HK company profile often includes official website directly.
    if market == "HK" and symbol:
        try:
            import akshare as ak

            stock = symbol.split(".", 1)[0].zfill(5)
            df = ak.stock_hk_company_profile_em(symbol=stock)
            if df is not None and not df.empty:
                val = str(df.iloc[0].get("公司网址") or "").strip()
                if val and val not in ("--", "None", "nan"):
                    if not val.startswith("http"):
                        val = f"https://{val}"
                    return val
        except Exception:
            pass

    # US/HK: yfinance often exposes official website.
    if symbol:
        try:
            import yfinance as yf

            symbol_up = symbol.upper()
            if market == "HK":
                code = symbol_up.split(".", 1)[0].lstrip("0") or symbol_up.split(".", 1)[0]
                yf_symbol = f"{code}.HK"
            elif market == "US":
                yf_symbol = symbol_up.split(".", 1)[0]
            else:
                yf_symbol = symbol_up
            tk = yf.Ticker(yf_symbol)
            info = tk.info or {}
            w = (info.get("website") or "").strip()
            if w.startswith("http"):
                return w
        except Exception:
            pass

    # CN fallback by company name -> symbol -> profile website
    if market == "CN" and not symbol and company_name:
        try:
            import akshare as ak

            cn_df = ak.stock_info_a_code_name()
            if cn_df is not None and not cn_df.empty:
                cols = set(cn_df.columns)
                name_col = "name" if "name" in cols else ("名称" if "名称" in cols else None)
                code_col = "code" if "code" in cols else ("代码" if "代码" in cols else None)
                if name_col and code_col:
                    q = (company_name or "").strip()
                    # Prefer exact match, then prefix/contains.
                    cand = cn_df[cn_df[name_col].astype(str) == q]
                    if cand.empty:
                        cand = cn_df[cn_df[name_col].astype(str).str.startswith(q)]
                    if cand.empty:
                        cand = cn_df[cn_df[name_col].astype(str).str.contains(q, regex=False)]
                    if not cand.empty:
                        guess_symbol = str(cand.iloc[0][code_col])[:6]
                        info_df = ak.stock_individual_info_em(symbol=guess_symbol)
                        if info_df is not None and not info_df.empty:
                            for _, row in info_df.iterrows():
                                item = str(row.get("item") or row.get("项目") or "")
                                val = str(row.get("value") or row.get("值") or "").strip()
                                if any(x in item for x in ["官网", "网站"]) and val.startswith("http"):
                                    return val
        except Exception:
            pass

    # Last fallback: search engine result (best effort).
    try:
        q = f"{company_name} 官方网站"
        r = requests.get(
            "https://duckduckgo.com/html/",
            params={"q": q},
            timeout=8,
            headers={"User-Agent": "Mozilla/5.0"},
        )
        if r.ok:
            links = re.findall(r'(?is)<a[^>]+class="result__a"[^>]+href="([^"]+)"', r.text)
            for u in links[:5]:
                # DuckDuckGo HTML often returns /l/?uddg=<encoded_target>
                if u.startswith("/"):
                    qd = parse_qs(urlparse(u).query)
                    uddg = (qd.get("uddg") or [""])[0]
                    if uddg:
                        u = unquote(uddg)
                pu = urlparse(u)
                if pu.scheme in ("http", "https") and pu.netloc:
                    return u
    except Exception:
        pass
    return None


def _fetch_company_history_from_website(website: str) -> tuple[str, Optional[str]]:
    if not website:
        return "", None
    try:
        homepage = requests.get(website, timeout=10, headers={"User-Agent": "Mozilla/5.0"})
    except Exception:
        return "", None
    if not homepage.ok:
        return "", None

    homepage.encoding = homepage.apparent_encoding or "utf-8"
    raw = homepage.text or ""
    links = _extract_links(website, raw)
    history_keywords = ["发展历程", "发展历史", "里程碑", "关于我们", "公司简介", "history", "about", "milestone"]

    candidates: list[str] = [website]
    for u in links:
        ul = u.lower()
        if any(k.lower() in ul for k in history_keywords):
            candidates.append(u)
        if len(candidates) >= 10:
            break

    best_text = _extract_text_from_html(raw)
    best_url = website
    best_score = _score_history_text(best_text)

    for u in candidates[1:10]:
        try:
            r = requests.get(u, timeout=10, headers={"User-Agent": "Mozilla/5.0"})
            if not r.ok:
                continue
            r.encoding = r.apparent_encoding or "utf-8"
            t = _extract_text_from_html(r.text or "")
            s = _score_history_text(t)
            if s > best_score:
                best_score = s
                best_text = t
                best_url = u
        except Exception:
            continue

    if not best_text:
        return "", None

    # Keep only dense history-like fragments.
    segs = re.split(r"[。.!?；;]", best_text)
    picked: list[str] = []
    for seg in segs:
        s = seg.strip()
        if len(s) < 12:
            continue
        if any(k in s.lower() for k in ["发展", "历史", "成立", "创立", "上市", "里程碑", "history", "founded", "milestone"]):
            picked.append(s)
        if len("。".join(picked)) > 900:
            break

    if not picked:
        picked = [best_text[:900]] if best_text else []
    result = "。".join(picked).strip()
    if result and not result.endswith("。"):
        result += "。"
    return result[:1200], best_url


def _normalize_company_name(name: str) -> str:
    s = (name or "").strip()
    if not s:
        return s
    # Remove common appended report date fragments, e.g. "百胜中国 2024-12-31"
    s = re.sub(r"\s*\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}日?\s*$", "", s)
    s = re.sub(r"\s*(年报|季报|中报|财报)\s*$", "", s)
    return s.strip()


@app.get("/api/reports/{report_id}/company-history", response_model=CompanyHistoryResponse)
def get_report_company_history(report_id: str):
    report = get_report(report_id)
    if not report:
        raise HTTPException(status_code=404, detail="Report not found")

    company_name = _normalize_company_name(report.report_name or "")
    if report.company_id:
        try:
            with session_scope() as s:
                c = s.get(Company, report.company_id)
                if c and c.name:
                    company_name = _normalize_company_name(c.name)
        except Exception:
            pass

    cache_key = f"{report_id}|{company_name}|{report.company_id or ''}|{report.market or ''}"
    now = time.time()
    hit = _COMPANY_HISTORY_CACHE.get(cache_key)
    if hit and now - hit[0] < _COMPANY_HISTORY_CACHE_TTL:
        data = hit[1]
        return CompanyHistoryResponse(**data)

    website = _find_official_website(report, company_name)
    history_text = ""
    source_url = None

    # HK company profile includes rich introduction/development history text.
    if report.company_id and report.company_id.startswith("HK:"):
        try:
            import akshare as ak

            symbol = report.company_id.split(":", 1)[1]
            stock = symbol.split(".", 1)[0].zfill(5)
            df = ak.stock_hk_company_profile_em(symbol=stock)
            if df is not None and not df.empty:
                intro = str(df.iloc[0].get("公司介绍") or "").strip()
                if intro and intro not in ("--", "None", "nan"):
                    history_text = intro[:1200]
                    source_url = website
                if not website:
                    w = str(df.iloc[0].get("公司网址") or "").strip()
                    if w and w not in ("--", "None", "nan"):
                        website = w if w.startswith("http") else f"https://{w}"
        except Exception:
            pass

    if website:
        web_history, web_source_url = _fetch_company_history_from_website(website)
        if web_history and len(web_history) >= len(history_text):
            history_text = web_history
            source_url = web_source_url

    payload = {
        "company_name": company_name,
        "website": website,
        "source_url": source_url,
        "history_text": history_text or "未能从公司官网提取到可用的发展历史，请稍后重试或补充公司官网链接。",
    }
    _COMPANY_HISTORY_CACHE[cache_key] = (now, payload)
    return CompanyHistoryResponse(**payload)


@app.get("/api/reports/{report_id}/industry-benchmarks")
def get_report_industry_benchmarks(report_id: str):
    """Get industry-specific benchmark averages for a report's company."""
    # Industry benchmark data by sector
    INDUSTRY_BENCHMARKS_BY_SECTOR = {
        "银行": {
            "GROSS_MARGIN": {"avg": None}, "NET_MARGIN": {"avg": 35.0}, "ROE": {"avg": 10.0},
            "ROA": {"avg": 0.8}, "CURRENT_RATIO": {"avg": None}, "DEBT_ASSET": {"avg": 92.0},
            "ASSET_TURNOVER": {"avg": 0.02},
        },
        "保险": {
            "GROSS_MARGIN": {"avg": None}, "NET_MARGIN": {"avg": 8.0}, "ROE": {"avg": 12.0},
            "ROA": {"avg": 1.0}, "CURRENT_RATIO": {"avg": None}, "DEBT_ASSET": {"avg": 88.0},
            "ASSET_TURNOVER": {"avg": 0.15},
        },
        "白酒": {
            "GROSS_MARGIN": {"avg": 75.0}, "NET_MARGIN": {"avg": 35.0}, "ROE": {"avg": 25.0},
            "ROA": {"avg": 18.0}, "CURRENT_RATIO": {"avg": 3.0}, "DEBT_ASSET": {"avg": 30.0},
            "ASSET_TURNOVER": {"avg": 0.5},
        },
        "制造业": {
            "GROSS_MARGIN": {"avg": 25.0}, "NET_MARGIN": {"avg": 8.0}, "ROE": {"avg": 12.0},
            "ROA": {"avg": 6.0}, "CURRENT_RATIO": {"avg": 1.5}, "DEBT_ASSET": {"avg": 55.0},
            "ASSET_TURNOVER": {"avg": 0.7},
        },
        "科技": {
            "GROSS_MARGIN": {"avg": 50.0}, "NET_MARGIN": {"avg": 18.0}, "ROE": {"avg": 18.0},
            "ROA": {"avg": 10.0}, "CURRENT_RATIO": {"avg": 2.5}, "DEBT_ASSET": {"avg": 35.0},
            "ASSET_TURNOVER": {"avg": 0.6},
        },
        "互联网": {
            "GROSS_MARGIN": {"avg": 45.0}, "NET_MARGIN": {"avg": 15.0}, "ROE": {"avg": 15.0},
            "ROA": {"avg": 8.0}, "CURRENT_RATIO": {"avg": 2.0}, "DEBT_ASSET": {"avg": 40.0},
            "ASSET_TURNOVER": {"avg": 0.5},
        },
        "餐饮": {
            "GROSS_MARGIN": {"avg": 60.0}, "NET_MARGIN": {"avg": 8.0}, "ROE": {"avg": 15.0},
            "ROA": {"avg": 8.0}, "CURRENT_RATIO": {"avg": 1.0}, "DEBT_ASSET": {"avg": 60.0},
            "ASSET_TURNOVER": {"avg": 1.2},
        },
        "零售": {
            "GROSS_MARGIN": {"avg": 25.0}, "NET_MARGIN": {"avg": 3.0}, "ROE": {"avg": 12.0},
            "ROA": {"avg": 5.0}, "CURRENT_RATIO": {"avg": 1.2}, "DEBT_ASSET": {"avg": 60.0},
            "ASSET_TURNOVER": {"avg": 2.0},
        },
        "医药": {
            "GROSS_MARGIN": {"avg": 60.0}, "NET_MARGIN": {"avg": 15.0}, "ROE": {"avg": 15.0},
            "ROA": {"avg": 8.0}, "CURRENT_RATIO": {"avg": 2.0}, "DEBT_ASSET": {"avg": 35.0},
            "ASSET_TURNOVER": {"avg": 0.5},
        },
        "房地产": {
            "GROSS_MARGIN": {"avg": 25.0}, "NET_MARGIN": {"avg": 8.0}, "ROE": {"avg": 10.0},
            "ROA": {"avg": 2.0}, "CURRENT_RATIO": {"avg": 1.3}, "DEBT_ASSET": {"avg": 78.0},
            "ASSET_TURNOVER": {"avg": 0.2},
        },
        "能源": {
            "GROSS_MARGIN": {"avg": 30.0}, "NET_MARGIN": {"avg": 10.0}, "ROE": {"avg": 12.0},
            "ROA": {"avg": 5.0}, "CURRENT_RATIO": {"avg": 1.2}, "DEBT_ASSET": {"avg": 55.0},
            "ASSET_TURNOVER": {"avg": 0.6},
        },
        "消费品": {
            "GROSS_MARGIN": {"avg": 40.0}, "NET_MARGIN": {"avg": 10.0}, "ROE": {"avg": 15.0},
            "ROA": {"avg": 8.0}, "CURRENT_RATIO": {"avg": 1.8}, "DEBT_ASSET": {"avg": 45.0},
            "ASSET_TURNOVER": {"avg": 0.8},
        },
        "默认": {
            "GROSS_MARGIN": {"avg": 32.0}, "NET_MARGIN": {"avg": 10.0}, "ROE": {"avg": 13.0},
            "ROA": {"avg": 6.0}, "CURRENT_RATIO": {"avg": 1.5}, "DEBT_ASSET": {"avg": 55.0},
            "ASSET_TURNOVER": {"avg": 0.7},
        },
    }

    def _detect_industry(company_name: str, industry_code: str | None) -> str:
        """Detect industry bucket from industry_code and company name."""
        s = (industry_code or "").strip().lower()
        name = (company_name or "").strip()
        combined = s + " " + name.lower()

        if any(kw in combined for kw in ["银行", "bank"]):
            return "银行"
        if any(kw in combined for kw in ["保险", "人寿", "财险", "insurance"]):
            return "保险"
        if any(kw in combined for kw in ["白酒", "五粮液", "茅台", "泸州老窖", "洋河", "汾酒", "酒"]):
            return "白酒"
        if any(kw in combined for kw in [
            "餐饮", "火锅", "海底捞", "小菜园", "小南国", "呷哺", "九毛九", "太二", "奈雪", "喜茶",
            "restaurant", "food service", "catering", "dining", "mcdonald", "starbucks", "yum",
            "chipotle", "darden", "domino", "pizza", "cafe", "coffee",
        ]):
            return "餐饮"
        if any(kw in combined for kw in [
            "零售", "retail", "超市", "百货", "walmart", "costco", "电商",
            "specialty retail", "grocery", "department store", "discount store",
            "home improvement", "apparel retail",
        ]):
            return "零售"
        if any(kw in combined for kw in [
            "医药", "制药", "生物", "pharma", "biotech", "drug", "health",
            "medical", "hospital", "diagnostic", "therapeut",
        ]):
            return "医药"
        if any(kw in combined for kw in [
            "互联网", "internet", "腾讯", "阿里", "美团", "字节", "百度", "京东", "拼多多",
            "meta", "google", "alphabet", "amazon", "netflix", "online",
            "interactive media", "internet content",
        ]):
            return "互联网"
        if any(kw in combined for kw in [
            "科技", "tech", "软件", "software", "芯片", "半导体", "semiconductor",
            "apple", "microsoft", "nvidia", "苹果", "英伟达",
            "information technology", "electronic", "computing", "cloud",
        ]):
            return "科技"
        if any(kw in combined for kw in ["房地产", "地产", "real estate", "property", "万科", "碧桂园", "恒大", "reit"]):
            return "房地产"
        if any(kw in combined for kw in [
            "能源", "石油", "石化", "energy", "oil", "gas", "煤炭", "电力",
            "petroleum", "natural gas", "utilities", "solar", "wind power",
        ]):
            return "能源"
        if any(kw in combined for kw in [
            "消费", "consumer", "食品", "饮料", "日用", "家电",
            "packaged food", "beverage", "household", "personal product",
            "consumer defensive", "consumer cyclical",
        ]):
            return "消费品"
        if any(kw in combined for kw in [
            "制造", "机械", "汽车", "电子", "工业", "manufacturing", "industrial",
            "auto", "aerospace", "defense", "machinery", "construction",
        ]):
            return "制造业"
        return "默认"

    report = get_report(report_id)
    if not report:
        raise HTTPException(status_code=404, detail="Report not found")

    company_name = report.report_name or ""
    industry_code = None
    try:
        if report.company_id:
            with session_scope() as s:
                c = s.get(Company, report.company_id)
                if c:
                    industry_code = c.industry_code
                    if c.name:
                        company_name = c.name
    except Exception:
        pass

    bucket = _detect_industry(company_name, industry_code)
    benchmarks = INDUSTRY_BENCHMARKS_BY_SECTOR.get(bucket, INDUSTRY_BENCHMARKS_BY_SECTOR["默认"])

    return {
        "industry": bucket,
        "industry_code": industry_code,
        "company_name": company_name,
        "benchmarks": {
            "grossMargin": benchmarks["GROSS_MARGIN"]["avg"],
            "netMargin": benchmarks["NET_MARGIN"]["avg"],
            "roe": benchmarks["ROE"]["avg"],
            "roa": benchmarks["ROA"]["avg"],
            "currentRatio": benchmarks["CURRENT_RATIO"]["avg"],
            "debtRatio": benchmarks["DEBT_ASSET"]["avg"],
            "assetTurnover": benchmarks["ASSET_TURNOVER"]["avg"],
        },
    }


@app.get("/api/reports/{report_id}/metrics", response_model=list[MetricResponse])
def get_report_metrics(report_id: str):
    """Get computed metrics for a report."""
    with session_scope() as s:
        report = s.get(Report, report_id)
        stmt = select(ComputedMetric).where(ComputedMetric.report_id == report_id)
        metrics = s.execute(stmt).scalars().all()
        rows = [
            MetricResponse(
                metric_code=m.metric_code,
                metric_name=m.metric_name,
                value=m.value,
                unit=m.unit,
                period_end=m.period_end,
            )
            for m in metrics
        ]

        # Backfill raw metrics for legacy reports:
        # TOTAL_REVENUE <- IS.REVENUE / statement aliases
        # OPERATING_CASH_FLOW <- CF.CFO / statement aliases
        alias_map = {
            "TOTAL_REVENUE": {
                "metric_aliases": ["IS.REVENUE"],
                "statement_aliases": ["IS.REVENUE", "IS.OPERATE_INCOME", "IS.TOTAL_REVENUE"],
                "name": "营业总收入",
                "unit": "",
            },
            "OPERATING_CASH_FLOW": {
                "metric_aliases": ["CF.CFO"],
                "statement_aliases": ["CF.CFO", "CF.NET_CASH_OPERATE", "CF.NET_CASH_FROM_OPERATING_ACTIVITIES"],
                "name": "经营现金流量净额",
                "unit": "",
            },
        }

        existing = {(r.metric_code, r.period_end) for r in rows}
        row_pos = {(r.metric_code, r.period_end): i for i, r in enumerate(rows)}

        def _upsert_metric(metric_code: str, metric_name: str, period_end: str, value: float, unit: str = "", *, prefer_larger: bool = False):
            key = (metric_code, period_end)
            idx = row_pos.get(key)
            if idx is None:
                rows.append(MetricResponse(metric_code=metric_code, metric_name=metric_name, value=value, unit=unit, period_end=period_end))
                existing.add(key)
                row_pos[key] = len(rows) - 1
                return
            try:
                old_v = rows[idx].value
                old_f = float(old_v) if old_v is not None else None
            except Exception:
                old_f = None
            should_replace = old_f is None
            if not should_replace and prefer_larger:
                try:
                    should_replace = abs(float(value)) > abs(float(old_f)) * 1.2
                except Exception:
                    should_replace = True
            if should_replace:
                rows[idx] = MetricResponse(metric_code=metric_code, metric_name=metric_name, value=value, unit=unit, period_end=period_end)

        def _infer_market_symbol_from_report() -> tuple[str | None, str | None]:
            if not report:
                return None, None
            if report.company_id and ":" in report.company_id:
                mk, sym = report.company_id.split(":", 1)
                return (mk or "").upper(), sym
            if report.source_type != "market_fetch":
                return None, None

            base_name = str(report.report_name or "").strip()
            base_name = re.sub(r"\s*\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}日?\s*$", "", base_name)
            base_name = re.sub(r"\s*(年报|季报|中报|财报)\s*$", "", base_name).strip()
            if not base_name:
                return None, None

            try:
                import akshare as ak

                us_df = ak.stock_us_spot_em()
                if us_df is not None and not us_df.empty:
                    name_col = "名称" if "名称" in us_df.columns else ("name" if "name" in us_df.columns else None)
                    code_col = "代码" if "代码" in us_df.columns else ("code" if "code" in us_df.columns else None)
                    if name_col and code_col:
                        hit = us_df[us_df[name_col].astype(str).str.contains(base_name, na=False)]
                        if not hit.empty:
                            sym = str(hit.iloc[0].get(code_col) or "").strip().upper()
                            if sym:
                                return "US", sym.split(".", 1)[0]
            except Exception:
                pass

            try:
                import akshare as ak

                hk_df = ak.stock_hk_spot_em()
                if hk_df is not None and not hk_df.empty:
                    name_col = "名称" if "名称" in hk_df.columns else ("name" if "name" in hk_df.columns else None)
                    code_col = "代码" if "代码" in hk_df.columns else ("code" if "code" in hk_df.columns else None)
                    if name_col and code_col:
                        hit = hk_df[hk_df[name_col].astype(str).str.contains(base_name, na=False)]
                        if not hit.empty:
                            raw = str(hit.iloc[0].get(code_col) or "").strip()
                            if raw:
                                code = raw.split(".", 1)[0].zfill(5)
                                return "HK", code
            except Exception:
                pass

            return None, None

        # 1) from existing computed metric aliases
        by_period_code: dict[tuple[str, str], float] = {}
        for r in rows:
            try:
                if r.value is not None:
                    by_period_code[(r.period_end, r.metric_code)] = float(r.value)
            except Exception:
                continue

        for target_code, cfg in alias_map.items():
            alias_codes = cfg["metric_aliases"]
            periods = sorted({p for (p, _) in by_period_code.keys()})
            for p in periods:
                if (target_code, p) in existing:
                    continue
                v = None
                for ac in alias_codes:
                    v = by_period_code.get((p, ac))
                    if v is not None:
                        break
                if v is None:
                    continue
                rows.append(MetricResponse(metric_code=target_code, metric_name=cfg["name"], value=v, unit=cfg["unit"], period_end=p))
                existing.add((target_code, p))

        # 2) from statement items aliases
        all_statement_aliases = set()
        for cfg in alias_map.values():
            all_statement_aliases.update(cfg["statement_aliases"])
        if all_statement_aliases:
            item_stmt = select(StatementItem).where(
                StatementItem.report_id == report_id,
                StatementItem.standard_item_code.in_(list(all_statement_aliases)),
            )
            items = s.execute(item_stmt).scalars().all()
            item_map: dict[tuple[str, str], float] = {}
            for it in items:
                try:
                    if it.value is None:
                        continue
                    item_map[(it.period_end, it.standard_item_code)] = float(it.value)
                except Exception:
                    continue

            periods = sorted({p for (p, _) in item_map.keys()})
            for target_code, cfg in alias_map.items():
                for p in periods:
                    if (target_code, p) in existing:
                        continue
                    v = None
                    for ac in cfg["statement_aliases"]:
                        v = item_map.get((p, ac))
                        if v is not None:
                            break
                    if v is None:
                        continue
                    rows.append(MetricResponse(metric_code=target_code, metric_name=cfg["name"], value=v, unit=cfg["unit"], period_end=p))
                    existing.add((target_code, p))

        # 3) from statement names (legacy/unknown item codes)
        missing_targets = [tc for tc in alias_map.keys() if not any(r.metric_code == tc for r in rows)]
        if missing_targets:
            name_stmt = select(StatementItem).where(StatementItem.report_id == report_id)
            all_items = s.execute(name_stmt).scalars().all()
            name_patterns = {
                "TOTAL_REVENUE": ["营业总收入", "营业收入", "总收入", "revenue"],
                "OPERATING_CASH_FLOW": ["经营活动产生的现金流量净额", "经营现金流量净额", "经营活动现金流净额", "经营业务现金净额", "cash from operations", "operating cash flow"],
            }

            for tc in missing_targets:
                pats = [x.lower() for x in name_patterns.get(tc, [])]
                best_by_period: dict[str, float] = {}
                for it in all_items:
                    if it.value is None:
                        continue
                    n1 = str(it.standard_item_name or "").lower()
                    n2 = str(it.original_item_name or "").lower()
                    text = f"{n1} {n2}"
                    if not any(p in text for p in pats):
                        continue
                    try:
                        best_by_period[it.period_end] = float(it.value)
                    except Exception:
                        continue

                cfg = alias_map[tc]
                for p, v in best_by_period.items():
                    if (tc, p) in existing:
                        continue
                    rows.append(MetricResponse(metric_code=tc, metric_name=cfg["name"], value=v, unit=cfg["unit"], period_end=p))
                    existing.add((tc, p))

        # 4) yfinance fallback for market_fetch HK/US when OCF/revenue are still missing.
        try:
            missing_now = [tc for tc in alias_map.keys() if not any(r.metric_code == tc for r in rows)]
            if missing_now and report and report.source_type == "market_fetch" and report.company_id and ":" in report.company_id:
                market, symbol = report.company_id.split(":", 1)
                market = (market or "").upper()
                if market in ("HK", "US"):
                    import yfinance as yf

                    sym_up = (symbol or "").upper()
                    if market == "HK":
                        code = sym_up.split(".", 1)[0].lstrip("0") or sym_up.split(".", 1)[0]
                        yf_symbol = f"{code}.HK"
                    else:
                        yf_symbol = sym_up.split(".", 1)[0]

                    tk = yf.Ticker(yf_symbol)
                    income_df = None
                    cash_df = None
                    try:
                        income_df = tk.financials
                    except Exception:
                        income_df = None
                    try:
                        cash_df = tk.cashflow
                    except Exception:
                        cash_df = None

                    def _pick_from_df(df, row_labels: list[str]) -> dict[str, float]:
                        out: dict[str, float] = {}
                        if df is None or getattr(df, "empty", True):
                            return out
                        idx_map = {str(i).strip().lower(): i for i in df.index}
                        row_key = None
                        for n in row_labels:
                            if n.lower() in idx_map:
                                row_key = idx_map[n.lower()]
                                break
                        if row_key is None:
                            for raw in df.index:
                                low = str(raw).strip().lower()
                                for n in row_labels:
                                    if n.lower() in low:
                                        row_key = raw
                                        break
                                if row_key is not None:
                                    break
                        if row_key is None:
                            return out
                        ser = df.loc[row_key]
                        for col, v in ser.items():
                            try:
                                if v is None or pd.isna(v):
                                    continue
                                d = pd.to_datetime(col).date().isoformat()
                                out[d] = float(v)
                            except Exception:
                                continue
                        return out

                    rev_map = _pick_from_df(income_df, ["Total Revenue", "Revenue"])
                    cfo_map = _pick_from_df(cash_df, ["Operating Cash Flow", "Cash Flow From Continuing Operating Activities"])

                    for p, v in rev_map.items():
                        if report and report.period_end and p > report.period_end:
                            continue
                        if "TOTAL_REVENUE" not in missing_now:
                            continue
                        if ("TOTAL_REVENUE", p) in existing:
                            continue
                        rows.append(MetricResponse(metric_code="TOTAL_REVENUE", metric_name="营业总收入", value=v, unit="", period_end=p))
                        existing.add(("TOTAL_REVENUE", p))
                    for p, v in cfo_map.items():
                        if report and report.period_end and p > report.period_end:
                            continue
                        if "OPERATING_CASH_FLOW" not in missing_now:
                            continue
                        if ("OPERATING_CASH_FLOW", p) in existing:
                            continue
                        rows.append(MetricResponse(metric_code="OPERATING_CASH_FLOW", metric_name="经营现金流量净额", value=v, unit="", period_end=p))
                        existing.add(("OPERATING_CASH_FLOW", p))
        except Exception:
            pass

        # 5) HK AkShare indicator fallback (often has 营业总收入 / 经营现金流量净额).
        try:
            missing_now = [tc for tc in alias_map.keys() if not any(r.metric_code == tc for r in rows)]
            need_prev = []
            if report and report.period_end:
                for tc in alias_map.keys():
                    has_prev = any((r.metric_code == tc) and (r.period_end or "") < (report.period_end or "") for r in rows)
                    if not has_prev:
                        need_prev.append(tc)
            if (missing_now or need_prev) and report and report.source_type == "market_fetch" and report.company_id and report.company_id.startswith("HK:"):
                import akshare as ak

                symbol = report.company_id.split(":", 1)[1]
                stock = symbol.split(".", 1)[0].zfill(5)
                ind_df = ak.stock_hk_financial_indicator_em(symbol=stock)
                if ind_df is not None and not ind_df.empty:
                    date_col = None
                    for c in ("REPORT_DATE", "报告期", "STD_REPORT_DATE", "日期"):
                        if c in ind_df.columns:
                            date_col = c
                            break

                    for _, row in ind_df.iterrows():
                        pe = report.period_end
                        if date_col:
                            try:
                                pe = pd.to_datetime(row.get(date_col)).date().isoformat()
                            except Exception:
                                pe = report.period_end

                        if ("TOTAL_REVENUE" in missing_now or "TOTAL_REVENUE" in need_prev) and ("TOTAL_REVENUE", pe) not in existing:
                            for k in ("营业总收入", "营业收入", "总收入"):
                                v = row.get(k)
                                try:
                                    if v is not None and str(v) not in ("", "--", "nan", "None"):
                                        rows.append(MetricResponse(metric_code="TOTAL_REVENUE", metric_name="营业总收入", value=float(v), unit="", period_end=pe))
                                        existing.add(("TOTAL_REVENUE", pe))
                                        break
                                except Exception:
                                    continue

                        if ("OPERATING_CASH_FLOW" in missing_now or "OPERATING_CASH_FLOW" in need_prev) and ("OPERATING_CASH_FLOW", pe) not in existing:
                            for k in ("经营活动产生的现金流量净额", "经营现金流量净额", "经营活动现金流净额", "经营业务现金净额"):
                                v = row.get(k)
                                try:
                                    if v is not None and str(v) not in ("", "--", "nan", "None"):
                                        rows.append(MetricResponse(metric_code="OPERATING_CASH_FLOW", metric_name="经营现金流量净额", value=float(v), unit="", period_end=pe))
                                        existing.add(("OPERATING_CASH_FLOW", pe))
                                        break
                                except Exception:
                                    continue
        except Exception:
            pass

        # 6) HK financial statements fallback for missing cash flow/revenue.
        try:
            missing_now = [tc for tc in alias_map.keys() if not any(r.metric_code == tc for r in rows)]
            need_prev = []
            if report and report.period_end:
                for tc in alias_map.keys():
                    has_prev = any((r.metric_code == tc) and (r.period_end or "") < (report.period_end or "") for r in rows)
                    if not has_prev:
                        need_prev.append(tc)
            if (missing_now or need_prev) and report and report.source_type == "market_fetch" and report.company_id and report.company_id.startswith("HK:"):
                import akshare as ak

                symbol = report.company_id.split(":", 1)[1]
                stock = symbol.split(".", 1)[0].zfill(5)

                def _pick_amount(df, keywords: list[str]) -> dict[str, float]:
                    out: dict[str, float] = {}
                    if df is None or df.empty:
                        return out
                    item_col = None
                    for c in ("STD_ITEM_NAME", "ITEM_NAME", "项目名称"):
                        if c in df.columns:
                            item_col = c
                            break
                    amt_col = "AMOUNT" if "AMOUNT" in df.columns else ("金额" if "金额" in df.columns else None)
                    date_col = None
                    for c in ("STD_REPORT_DATE", "REPORT_DATE", "报告期"):
                        if c in df.columns:
                            date_col = c
                            break
                    if not item_col or not amt_col:
                        return out

                    for _, rr in df.iterrows():
                        item_name = str(rr.get(item_col) or "")
                        if not any(k in item_name for k in keywords):
                            continue
                        v = rr.get(amt_col)
                        if v is None or str(v) in ("", "--", "None", "nan"):
                            continue
                        try:
                            pe = report.period_end
                            if date_col:
                                pe = pd.to_datetime(rr.get(date_col)).date().isoformat()
                            out[pe] = float(v)
                        except Exception:
                            continue
                    return out

                profit_df = None
                cash_df = None
                try:
                    profit_df = ak.stock_financial_hk_report_em(stock=stock, symbol="利润表", indicator="年度")
                except Exception:
                    profit_df = None
                try:
                    cash_df = ak.stock_financial_hk_report_em(stock=stock, symbol="现金流量表", indicator="年度")
                except Exception:
                    cash_df = None

                if "TOTAL_REVENUE" in missing_now or "TOTAL_REVENUE" in need_prev:
                    rev_map = _pick_amount(profit_df, ["营业额", "营运收入", "营业总收入", "营业收入", "总收入", "Turnover", "Revenue", "Total revenue"])
                    for pe, v in rev_map.items():
                        _upsert_metric("TOTAL_REVENUE", "营业总收入", pe, v, "", prefer_larger=True)

                if "OPERATING_CASH_FLOW" in missing_now or "OPERATING_CASH_FLOW" in need_prev:
                    cfo_map = _pick_amount(cash_df, ["经营活动产生的现金流量净额", "经营现金流量净额", "经营活动现金流净额", "经营业务现金净额"])
                    for pe, v in cfo_map.items():
                        _upsert_metric("OPERATING_CASH_FLOW", "经营现金流量净额", pe, v, "", prefer_larger=True)
        except Exception:
            pass

        # 7) US AkShare statements fallback for missing/previous-period revenue & CFO.
        try:
            missing_now = [tc for tc in alias_map.keys() if not any(r.metric_code == tc for r in rows)]
            need_prev = []
            if report and report.period_end:
                for tc in alias_map.keys():
                    has_prev = any((r.metric_code == tc) and (r.period_end or "") < (report.period_end or "") for r in rows)
                    if not has_prev:
                        need_prev.append(tc)
            if (missing_now or need_prev) and report and report.source_type == "market_fetch" and report.company_id and report.company_id.startswith("US:"):
                import akshare as ak

                symbol = report.company_id.split(":", 1)[1]
                stock = symbol.split(".", 1)[0].upper()

                def _pick_amount_map(df, keywords: list[str]) -> dict[str, float]:
                    out = {}
                    if df is None or df.empty:
                        return out
                    item_col = "ITEM_NAME" if "ITEM_NAME" in df.columns else ("STD_ITEM_NAME" if "STD_ITEM_NAME" in df.columns else None)
                    amt_col = "AMOUNT" if "AMOUNT" in df.columns else ("金额" if "金额" in df.columns else None)
                    date_col = "REPORT_DATE" if "REPORT_DATE" in df.columns else ("STD_REPORT_DATE" if "STD_REPORT_DATE" in df.columns else None)
                    if not item_col or not amt_col:
                        return out
                    for _, rr in df.iterrows():
                        nm = str(rr.get(item_col) or "")
                        if not any(k.lower() in nm.lower() for k in keywords):
                            continue
                        v = rr.get(amt_col)
                        if v is None or str(v) in ("", "--", "None", "nan"):
                            continue
                        try:
                            pe = report.period_end
                            if date_col:
                                pe = pd.to_datetime(rr.get(date_col)).date().isoformat()
                            out[pe] = float(v)
                        except Exception:
                            continue
                    return out

                income_df = None
                cash_df = None
                try:
                    income_df = ak.stock_financial_us_report_em(stock=stock, symbol="综合损益表", indicator="年报")
                except Exception:
                    income_df = None
                try:
                    cash_df = ak.stock_financial_us_report_em(stock=stock, symbol="现金流量表", indicator="年报")
                except Exception:
                    cash_df = None

                if "TOTAL_REVENUE" in missing_now or "TOTAL_REVENUE" in need_prev:
                    rev_map = _pick_amount_map(income_df, ["营业收入", "营业总收入", "总收入", "Revenue", "Total revenue"])
                    for pe, v in rev_map.items():
                        _upsert_metric("TOTAL_REVENUE", "营业总收入", pe, v, "", prefer_larger=True)

                if "OPERATING_CASH_FLOW" in missing_now or "OPERATING_CASH_FLOW" in need_prev:
                    cfo_map = _pick_amount_map(cash_df, ["经营活动产生的现金流量净额", "经营活动现金流量净额", "经营现金流量净额", "Operating Cash Flow", "Cash Flow From Continuing Operating Activities"])
                    for pe, v in cfo_map.items():
                        _upsert_metric("OPERATING_CASH_FLOW", "经营现金流量净额", pe, v, "", prefer_larger=True)
        except Exception:
            pass

        # 8) Backfill previous-period ratio metrics for market_fetch HK/US (YoY display support).
        try:
            ratio_map = {
                "GROSS_MARGIN": ("毛利率", "%"),
                "NET_MARGIN": ("净利率", "%"),
                "ROE": ("ROE", "%"),
                "ROA": ("ROA", "%"),
                "DEBT_ASSET": ("资产负债率", "%"),
                "CURRENT_RATIO": ("流动比率", "times"),
                "QUICK_RATIO": ("速动比率", "times"),
            }
            need_prev_ratio = []
            if report and report.period_end:
                for code in ratio_map.keys():
                    has_prev = any((r.metric_code == code) and (r.period_end or "") < report.period_end for r in rows)
                    if not has_prev:
                        need_prev_ratio.append(code)

            if need_prev_ratio and report and report.source_type == "market_fetch":
                mk, sym = _infer_market_symbol_from_report()
                if mk in ("US", "HK") and sym:
                    import akshare as ak

                    if mk == "US":
                        ind_df = ak.stock_financial_us_analysis_indicator_em(symbol=sym.split(".", 1)[0].upper(), indicator="年报")
                        if ind_df is not None and not ind_df.empty:
                            date_col = "REPORT_DATE" if "REPORT_DATE" in ind_df.columns else ("STD_REPORT_DATE" if "STD_REPORT_DATE" in ind_df.columns else None)
                            col_map = {
                                "GROSS_MARGIN": ["GROSS_PROFIT_RATIO"],
                                "NET_MARGIN": ["NET_PROFIT_RATIO"],
                                "ROE": ["ROE_AVG", "ROE"],
                                "ROA": ["ROA"],
                                "DEBT_ASSET": ["DEBT_ASSET_RATIO"],
                                "CURRENT_RATIO": ["CURRENT_RATIO"],
                                "QUICK_RATIO": ["SPEED_RATIO", "QUICK_RATIO"],
                            }
                            for _, rr in ind_df.iterrows():
                                pe = report.period_end
                                if date_col:
                                    try:
                                        pe = pd.to_datetime(rr.get(date_col)).date().isoformat()
                                    except Exception:
                                        pe = report.period_end
                                if report.period_end and pe > report.period_end:
                                    continue
                                for code in need_prev_ratio:
                                    if code not in col_map:
                                        continue
                                    val = None
                                    for c in col_map[code]:
                                        if c in ind_df.columns:
                                            try:
                                                v = rr.get(c)
                                                if v is not None and str(v) not in ("", "--", "nan", "None"):
                                                    val = float(v)
                                                    break
                                            except Exception:
                                                continue
                                    if val is None:
                                        continue
                                    nm, unit = ratio_map[code]
                                    _upsert_metric(code, nm, pe, val, unit, prefer_larger=False)
                    elif mk == "HK":
                        stock = sym.split(".", 1)[0].zfill(5)
                        profit_df = ak.stock_financial_hk_report_em(stock=stock, symbol="利润表", indicator="年度")
                        balance_df = ak.stock_financial_hk_report_em(stock=stock, symbol="资产负债表", indicator="年度")

                        def _map_amount(df, keywords: list[str]) -> dict[str, float]:
                            out: dict[str, float] = {}
                            if df is None or df.empty:
                                return out
                            date_col = "REPORT_DATE" if "REPORT_DATE" in df.columns else ("STD_REPORT_DATE" if "STD_REPORT_DATE" in df.columns else None)
                            item_col = "STD_ITEM_NAME" if "STD_ITEM_NAME" in df.columns else ("ITEM_NAME" if "ITEM_NAME" in df.columns else None)
                            val_col = "AMOUNT" if "AMOUNT" in df.columns else ("金额" if "金额" in df.columns else None)
                            if not item_col or not val_col:
                                return out
                            for _, rr in df.iterrows():
                                nm = str(rr.get(item_col) or "")
                                low = nm.lower()
                                if not any((k in nm) or (k.lower() in low) for k in keywords):
                                    continue
                                v = rr.get(val_col)
                                if v is None or str(v) in ("", "--", "nan", "None"):
                                    continue
                                try:
                                    pe = report.period_end
                                    if date_col:
                                        pe = pd.to_datetime(rr.get(date_col)).date().isoformat()
                                    if report.period_end and pe > report.period_end:
                                        continue
                                    fv = float(v)
                                    old = out.get(pe)
                                    if old is None or abs(fv) > abs(float(old)):
                                        out[pe] = fv
                                except Exception:
                                    continue
                            return out

                        rev = _map_amount(profit_df, ["营运收入", "营业额", "营业总收入", "营业收入", "总收入", "Turnover", "Revenue", "Total revenue"])
                        gp = _map_amount(profit_df, ["毛利", "毛利润", "Gross profit"])
                        np_map = _map_amount(profit_df, ["股东应占溢利", "净利润", "本年溢利", "年度利润", "Net profit"])

                        ta = _map_amount(balance_df, ["总资产", "资产总计", "资产合计", "Total Assets"])
                        tl = _map_amount(balance_df, ["负债合计", "总负债", "Total Liabilities"])
                        te = _map_amount(balance_df, ["股东权益", "权益合计", "总权益", "净资产", "Total Equity"])
                        ca = _map_amount(balance_df, ["流动资产合计", "流动资产总值", "Current Assets"])
                        cl = _map_amount(balance_df, ["流动负债合计", "流动负债总额", "Current Liabilities"])
                        inv = _map_amount(balance_df, ["存货", "Inventory"])

                        all_periods = sorted(set(list(rev.keys()) + list(np_map.keys()) + list(ta.keys()) + list(tl.keys()) + list(te.keys()) + list(ca.keys()) + list(cl.keys())))
                        for pe in all_periods:
                            if report.period_end and pe > report.period_end:
                                continue
                            rv = rev.get(pe)
                            gpv = gp.get(pe)
                            npv = np_map.get(pe)
                            tav = ta.get(pe)
                            tlv = tl.get(pe)
                            tev = te.get(pe)
                            cav = ca.get(pe)
                            clv = cl.get(pe)
                            iv = inv.get(pe)

                            try:
                                if "GROSS_MARGIN" in need_prev_ratio and rv not in (None, 0) and gpv is not None:
                                    _upsert_metric("GROSS_MARGIN", "毛利率", pe, float(gpv) / float(rv) * 100.0, "%")
                                if "NET_MARGIN" in need_prev_ratio and rv not in (None, 0) and npv is not None:
                                    _upsert_metric("NET_MARGIN", "净利率", pe, float(npv) / float(rv) * 100.0, "%")
                                if "ROE" in need_prev_ratio and tev not in (None, 0) and npv is not None:
                                    _upsert_metric("ROE", "ROE", pe, float(npv) / float(tev) * 100.0, "%")
                                if "ROA" in need_prev_ratio and tav not in (None, 0) and npv is not None:
                                    _upsert_metric("ROA", "ROA", pe, float(npv) / float(tav) * 100.0, "%")
                                if "DEBT_ASSET" in need_prev_ratio and tav not in (None, 0) and tlv is not None:
                                    _upsert_metric("DEBT_ASSET", "资产负债率", pe, float(tlv) / float(tav) * 100.0, "%")
                                if "CURRENT_RATIO" in need_prev_ratio and clv not in (None, 0) and cav is not None:
                                    _upsert_metric("CURRENT_RATIO", "流动比率", pe, float(cav) / float(clv), "times")
                                if "QUICK_RATIO" in need_prev_ratio and clv not in (None, 0) and cav is not None and iv is not None:
                                    _upsert_metric("QUICK_RATIO", "速动比率", pe, (float(cav) - float(iv)) / float(clv), "times")
                            except Exception:
                                continue
        except Exception:
            pass

        return rows


@app.get("/api/reports/{report_id}/alerts", response_model=list[AlertResponse])
def get_report_alerts(report_id: str):
    """Get alerts for a report."""
    with session_scope() as s:
        stmt = select(Alert).where(Alert.report_id == report_id)
        alerts = s.execute(stmt).scalars().all()
        return [
            AlertResponse(
                id=a.id,
                alert_code=a.alert_code,
                level=a.level,
                title=a.title,
                message=a.message,
                period_end=a.period_end,
            )
            for a in alerts
        ]


@app.get("/api/portfolio/positions", response_model=list[PortfolioPositionResponse])
def list_portfolio_positions():
    import concurrent.futures as _cf

    def _normalize_market(m: str) -> str:
        mm = (m or "").strip().upper()
        return mm or "CN"

    # First, collect all positions from DB
    positions_raw: list[tuple] = []
    with session_scope() as s:
        rows = s.execute(select(PortfolioPosition).order_by(PortfolioPosition.updated_at.desc())).scalars().all()
        for p in rows:
            market = _normalize_market(p.market)
            symbol = (p.symbol or "").strip().upper()
            name = (p.name or "").strip() or None
            positions_raw.append((p, market, symbol, name))

    # Parallel fetch prices for all positions with timeout
    def _fetch_price_for_pos(args):
        p, market, symbol, name = args
        import concurrent.futures as _cf2
        try:
            def _do_fetch():
                sp = get_stock_price(symbol=symbol, market=market)
                return getattr(sp, "price", None) if sp is not None else None
            # Run with 5s timeout to prevent slow yfinance calls from blocking
            with _cf2.ThreadPoolExecutor(max_workers=1) as _ex:
                fut = _ex.submit(_do_fetch)
                try:
                    price = fut.result(timeout=5.0)
                except Exception:
                    price = None
        except Exception:
            price = None
        return (p, market, symbol, name, price)

    # Use ThreadPoolExecutor to fetch prices in parallel with per-task timeout
    prices_map: dict[tuple, float | None] = {}
    try:
        with _cf.ThreadPoolExecutor(max_workers=min(10, max(1, len(positions_raw)))) as ex:
            futures = {ex.submit(_fetch_price_for_pos, args): args for args in positions_raw}
            for fut in _cf.as_completed(futures, timeout=30):
                try:
                    p, market, symbol, name, price = fut.result(timeout=5)
                    prices_map[(market, symbol)] = price
                except Exception:
                    # Individual task failed or timed out
                    args = futures[fut]
                    _, market, symbol, _ = args
                    prices_map[(market, symbol)] = None
    except Exception:
        # Fallback: use None for any missing prices
        for p, market, symbol, name in positions_raw:
            prices_map.setdefault((market, symbol), None)

    out: list[PortfolioPositionResponse] = []
    for p, market, symbol, name in positions_raw:
        current_price = prices_map.get((market, symbol))

        qty = float(p.quantity or 0.0)
        avg_cost = float(p.avg_cost or 0.0)
        mv = None
        pnl = None
        pnl_pct = None
        if current_price is not None:
            mv = current_price * qty
            pnl = (current_price - avg_cost) * qty
            pnl_pct = None if avg_cost <= 0 else (current_price / avg_cost - 1.0) * 100.0

        # Use cached indicators only (no blocking fetch).
        # If cache is empty, return nulls — frontend or direct
        # /api/stock/indicators call will populate the cache.
        strategy_buy_price = None
        strategy_buy_ok = None
        strategy_buy_reason = None
        strategy_buy_desc = None
        strategy_sell_price = None
        strategy_sell_ok = None
        strategy_sell_reason = None
        strategy_sell_desc = None
        try:
            _ind_key = (market, symbol)
            _ind_cached = _INDICATOR_CACHE.get(_ind_key)
            si = _ind_cached[1] if _ind_cached else None
            if si is not None:
                if isinstance(si, dict):
                    strategy_buy_price = si.get("buy_price_aggressive")
                    strategy_buy_ok = si.get("buy_price_aggressive_ok")
                    strategy_buy_reason = si.get("buy_reason")
                    strategy_buy_desc = si.get("buy_condition_desc")
                    strategy_sell_price = si.get("sell_price")
                    strategy_sell_ok = si.get("sell_price_ok")
                    strategy_sell_reason = si.get("sell_reason")
                    strategy_sell_desc = si.get("sell_condition_desc")
                else:
                    strategy_buy_price = getattr(si, "buy_price_aggressive", None)
                    strategy_buy_ok = getattr(si, "buy_price_aggressive_ok", None)
                    strategy_buy_reason = getattr(si, "buy_reason", None)
                    strategy_buy_desc = getattr(si, "buy_condition_desc", None)
                    strategy_sell_price = getattr(si, "sell_price", None)
                    strategy_sell_ok = getattr(si, "sell_price_ok", None)
                    strategy_sell_reason = getattr(si, "sell_reason", None)
                    strategy_sell_desc = getattr(si, "sell_condition_desc", None)
        except Exception:
            pass

        out.append(
            PortfolioPositionResponse(
                id=p.id,
                market=market,
                symbol=symbol,
                name=name,
                quantity=qty,
                avg_cost=avg_cost,
                target_buy_price=p.target_buy_price,
                target_sell_price=p.target_sell_price,
                current_price=current_price,
                market_value=mv,
                unrealized_pnl=pnl,
                unrealized_pnl_pct=pnl_pct,
                strategy_buy_price=strategy_buy_price,
                strategy_buy_ok=strategy_buy_ok,
                strategy_buy_reason=strategy_buy_reason,
                strategy_buy_desc=strategy_buy_desc,
                strategy_sell_price=strategy_sell_price,
                strategy_sell_ok=strategy_sell_ok,
                strategy_sell_reason=strategy_sell_reason,
                strategy_sell_desc=strategy_sell_desc,
                updated_at=int(p.updated_at or 0),
            )
        )

    return out


@app.post("/api/portfolio/positions", response_model=PortfolioPositionResponse)
def create_portfolio_position(req: PortfolioCreatePositionRequest):
    market = (req.market or "CN").strip().upper()
    symbol = normalize_symbol(market, req.symbol)
    name = (req.name or "").strip() or None
    now = int(time.time())

    with session_scope() as s:
        existing = s.execute(
            select(PortfolioPosition).where(
                PortfolioPosition.market == market,
                PortfolioPosition.symbol == symbol,
            )
        ).scalars().first()

        if existing:
            if name is not None:
                existing.name = name
            existing.target_buy_price = req.target_buy_price
            existing.target_sell_price = req.target_sell_price
            existing.updated_at = now
            p = existing
        else:
            p = PortfolioPosition(
                market=market,
                symbol=symbol,
                name=name,
                quantity=0.0,
                avg_cost=0.0,
                target_buy_price=req.target_buy_price,
                target_sell_price=req.target_sell_price,
                created_at=now,
                updated_at=now,
            )
            s.add(p)
            s.flush()

    # reuse list calculation logic
    res = list_portfolio_positions()
    for it in res:
        if it.market == market and it.symbol == symbol:
            return it
    raise HTTPException(status_code=500, detail="create_position_failed")


@app.patch("/api/portfolio/positions/{position_id}", response_model=PortfolioPositionResponse)
def update_portfolio_position(position_id: str, req: PortfolioUpdatePositionRequest):
    now = int(time.time())
    with session_scope() as s:
        p = s.get(PortfolioPosition, position_id)
        if not p:
            raise HTTPException(status_code=404, detail="position not found")
        if req.name is not None:
            p.name = (req.name or "").strip() or None
        if req.target_buy_price is not None or req.target_buy_price is None:
            p.target_buy_price = req.target_buy_price
        if req.target_sell_price is not None or req.target_sell_price is None:
            p.target_sell_price = req.target_sell_price
        p.updated_at = now
        market = (p.market or "CN").strip().upper()
        symbol = (p.symbol or "").strip().upper()

    res = list_portfolio_positions()
    for it in res:
        if it.market == market and it.symbol == symbol:
            return it
    raise HTTPException(status_code=500, detail="update_position_failed")


@app.delete("/api/portfolio/positions/{position_id}")
def delete_portfolio_position(position_id: str):
    with session_scope() as s:
        p = s.get(PortfolioPosition, position_id)
        if not p:
            return {"ok": True}
        s.execute(delete(PortfolioAutoTrade).where(PortfolioAutoTrade.position_id == position_id))
        s.execute(delete(PortfolioTrade).where(PortfolioTrade.position_id == position_id))
        s.execute(delete(PortfolioPosition).where(PortfolioPosition.id == position_id))
    return {"ok": True}


@app.post("/api/portfolio/trades", response_model=PortfolioTradeResponse)
def create_portfolio_trade(req: PortfolioTradeRequest):
    side = (req.side or "").strip().upper()
    if side not in {"BUY", "SELL"}:
        raise HTTPException(status_code=400, detail="invalid side")
    try:
        qty = float(req.quantity)
    except Exception:
        qty = 0.0
    if qty <= 0:
        raise HTTPException(status_code=400, detail="invalid quantity")

    now = int(time.time())
    with session_scope() as s:
        p = s.get(PortfolioPosition, req.position_id)
        if not p:
            raise HTTPException(status_code=404, detail="position not found")
        market = (p.market or "CN").strip().upper()
        symbol = (p.symbol or "").strip().upper()

        sp = get_stock_price(symbol=symbol, market=market)
        price = getattr(sp, "price", None) if sp is not None else None
        if price is None:
            raise HTTPException(status_code=400, detail="cannot_get_latest_price")
        price = float(price)

        amount = price * qty
        old_qty = float(p.quantity or 0.0)
        old_avg = float(p.avg_cost or 0.0)

        if side == "BUY":
            new_qty = old_qty + qty
            new_avg = 0.0 if new_qty <= 0 else (old_qty * old_avg + qty * price) / new_qty
            p.quantity = new_qty
            p.avg_cost = new_avg
        else:
            new_qty = max(0.0, old_qty - qty)
            p.quantity = new_qty
            if new_qty <= 0:
                p.avg_cost = 0.0

        p.updated_at = now

        t = PortfolioTrade(
            position_id=p.id,
            side=side,
            price=price,
            quantity=qty,
            amount=amount,
            created_at=now,
        )
        s.add(t)
        s.flush()

        pos_id = p.id
        # Auto-delete position when fully sold (quantity reaches 0)
        if side == "SELL" and new_qty <= 0:
            s.query(PortfolioTrade).filter(PortfolioTrade.position_id == pos_id, PortfolioTrade.id != t.id).delete()
            s.delete(t)
            s.delete(p)

        return PortfolioTradeResponse(
            id=t.id,
            position_id=pos_id,
            side=side,
            price=price,
            quantity=qty,
            amount=amount,
            created_at=now,
        )


# ── Auto-Trade endpoints ──────────────────────────────────────────────

@app.post("/api/portfolio/auto-trades", response_model=PortfolioAutoTradeResponse)
def create_auto_trade(req: PortfolioAutoTradeRequest):
    side = (req.side or "").strip().upper()
    if side not in {"BUY", "SELL"}:
        raise HTTPException(status_code=400, detail="invalid side")
    if req.trigger_price <= 0:
        raise HTTPException(status_code=400, detail="invalid trigger_price")
    if req.quantity <= 0:
        raise HTTPException(status_code=400, detail="invalid quantity")

    now = int(time.time())
    with session_scope() as s:
        p = s.get(PortfolioPosition, req.position_id)
        if not p:
            raise HTTPException(status_code=404, detail="position not found")
        at = PortfolioAutoTrade(
            position_id=p.id,
            side=side,
            trigger_price=req.trigger_price,
            quantity=req.quantity,
            status="PENDING",
            created_at=now,
        )
        s.add(at)
        s.flush()
        return PortfolioAutoTradeResponse(
            id=at.id, position_id=p.id, side=side,
            trigger_price=req.trigger_price, quantity=req.quantity,
            status="PENDING", created_at=now,
            symbol=p.symbol, name=p.name, market=p.market,
        )


@app.get("/api/portfolio/auto-trades", response_model=list[PortfolioAutoTradeResponse])
def list_auto_trades():
    with session_scope() as s:
        rows = s.execute(
            select(PortfolioAutoTrade, PortfolioPosition)
            .join(PortfolioPosition, PortfolioAutoTrade.position_id == PortfolioPosition.id)
            .order_by(PortfolioAutoTrade.created_at.desc())
        ).all()
        result = []
        for at, p in rows:
            result.append(PortfolioAutoTradeResponse(
                id=at.id, position_id=at.position_id, side=at.side,
                trigger_price=at.trigger_price, quantity=at.quantity,
                status=at.status, created_at=at.created_at,
                executed_at=at.executed_at, executed_price=at.executed_price,
                symbol=p.symbol, name=p.name, market=p.market,
            ))
        return result


@app.delete("/api/portfolio/auto-trades/{auto_trade_id}")
def cancel_auto_trade(auto_trade_id: str):
    with session_scope() as s:
        at = s.get(PortfolioAutoTrade, auto_trade_id)
        if not at:
            return {"ok": True}
        if at.status == "PENDING":
            at.status = "CANCELLED"
    return {"ok": True}


def _get_today_high_low(symbol: str, market: str):
    """Get today's high and low price from history data (cached, no real-time fetch)."""
    import pandas as pd
    try:
        df = _fetch_history_df(symbol, market)
        if df is None or df.empty:
            return None, None
        last_row = df.iloc[-1]
        high = pd.to_numeric(last_row.get("high"), errors="coerce")
        low = pd.to_numeric(last_row.get("low"), errors="coerce")
        close = pd.to_numeric(last_row.get("close"), errors="coerce")
        h = float(high) if pd.notna(high) else None
        l = float(low) if pd.notna(low) else None
        c = float(close) if pd.notna(close) else None
        return h, l, c
    except Exception:
        return None, None, None


def _execute_auto_trade(at_id: str):
    """Execute a single triggered auto-trade order using today's high/low."""
    import logging
    log = logging.getLogger("auto_trade")
    try:
        with session_scope() as s:
            at = s.get(PortfolioAutoTrade, at_id)
            if not at or at.status != "PENDING":
                return
            p = s.get(PortfolioPosition, at.position_id)
            if not p:
                at.status = "CANCELLED"
                return

            market = (p.market or "CN").strip().upper()
            symbol = (p.symbol or "").strip().upper()

            result = _get_today_high_low(symbol, market)
            if result is None or len(result) < 3:
                return
            day_high, day_low, day_close = result
            if day_high is None or day_low is None:
                return

            # Check if trigger price was reached intraday
            triggered = False
            exec_price = None
            if at.side == "BUY" and day_low <= at.trigger_price:
                triggered = True
                exec_price = at.trigger_price  # assume filled at trigger price
            elif at.side == "SELL" and day_high >= at.trigger_price:
                triggered = True
                exec_price = at.trigger_price

            if not triggered:
                return

            qty = float(at.quantity)
            old_qty = float(p.quantity or 0.0)
            old_avg = float(p.avg_cost or 0.0)
            now = int(time.time())

            if at.side == "BUY":
                new_qty = old_qty + qty
                new_avg = (old_qty * old_avg + qty * exec_price) / new_qty if new_qty > 0 else 0.0
                p.quantity = new_qty
                p.avg_cost = new_avg
            else:
                if old_qty <= 0:
                    at.status = "CANCELLED"
                    return
                actual_qty = min(qty, old_qty)
                new_qty = old_qty - actual_qty
                p.quantity = new_qty
                if new_qty <= 0:
                    p.avg_cost = 0.0

            p.updated_at = now

            trade = PortfolioTrade(
                position_id=p.id, side=at.side, price=exec_price,
                quantity=qty, amount=exec_price * qty, created_at=now,
            )
            s.add(trade)

            at.status = "EXECUTED"
            at.executed_at = now
            at.executed_price = exec_price

            # Auto-delete position when fully sold
            if at.side == "SELL" and new_qty <= 0:
                s.query(PortfolioTrade).filter(PortfolioTrade.position_id == p.id).delete()
                s.query(PortfolioAutoTrade).filter(
                    PortfolioAutoTrade.position_id == p.id,
                    PortfolioAutoTrade.id != at.id,
                ).delete()
                s.delete(at)
                s.delete(p)

            log.info(f"Auto-trade executed: {at.side} {qty} of {symbol} @ {exec_price} (day H/L: {day_high}/{day_low})")
    except Exception as e:
        import logging
        logging.getLogger("auto_trade").error(f"Auto-trade error: {e}")


# ── Market-aware auto-trade scheduler ──────────────────────────────────
# Each market checks once per trading day after close.
#   CN (A股): Mon-Fri, check at 17:00 Beijing time
#   HK (港股): Mon-Fri, check at 17:30 Beijing time
#   US (美股): Mon-Fri, check at 05:30 Beijing time (next calendar day vs US trading day)
# After checking, untriggered PENDING orders for that market are auto-cancelled.

_TZ_BEIJING = _ZoneInfo("Asia/Shanghai")

# (check_hour, check_minute) in Beijing time
_MARKET_CHECK_TIMES: dict[str, tuple[int, int]] = {
    "CN": (17, 0),
    "HK": (17, 30),
    "US": (5, 30),   # next calendar day in Beijing = after US close
}

# Track which (market, date_str) combos have already been checked today
_auto_trade_checked: dict[tuple[str, str], bool] = {}


def _is_trading_day(market: str, dt_beijing: _dt.datetime) -> bool:
    """Return True if dt_beijing falls on a trading day for the market.
    Simple rule: weekdays only (Mon-Fri). Does not account for public holidays."""
    wd = dt_beijing.weekday()  # 0=Mon .. 6=Sun
    if market == "US":
        # For US, the trading day that closes at 05:30 Beijing time on day D
        # is actually the US trading day of (D-1) in New York.
        # But the relevant question is: was yesterday (Beijing) a US weekday?
        us_trade_date = (dt_beijing - _dt.timedelta(days=1)).date()
        return us_trade_date.weekday() < 5
    return wd < 5  # CN / HK: same calendar day


def _check_time_key(market: str, dt_beijing: _dt.datetime) -> str:
    """Return a date-string key representing which trading session this check covers."""
    if market == "US":
        return (dt_beijing - _dt.timedelta(days=1)).date().isoformat()
    return dt_beijing.date().isoformat()


def _auto_trade_checker():
    """Background thread: market-aware auto-trade checker.
    Wakes every 5 minutes, checks if any market's post-close check time has arrived,
    and if so processes pending orders for that market exactly once per trading day."""
    import logging
    log = logging.getLogger("auto_trade")
    log.info("Auto-trade checker started (market-aware scheduler)")
    while True:
        try:
            time.sleep(300)  # wake every 5 minutes
            now_bj = _dt.datetime.now(_TZ_BEIJING)

            for mkt, (chk_h, chk_m) in _MARKET_CHECK_TIMES.items():
                # Has the check time passed today?
                check_dt = now_bj.replace(hour=chk_h, minute=chk_m, second=0, microsecond=0)
                if now_bj < check_dt:
                    continue  # not yet time

                if not _is_trading_day(mkt, now_bj):
                    continue  # not a trading day

                day_key = _check_time_key(mkt, now_bj)
                cache_key = (mkt, day_key)
                if _auto_trade_checked.get(cache_key):
                    continue  # already checked this session

                log.info(f"[{mkt}] Post-close check for trading day {day_key}")
                _auto_trade_checked[cache_key] = True

                # Gather pending orders for this market
                with session_scope() as s:
                    pending = s.execute(
                        select(PortfolioAutoTrade)
                        .join(PortfolioPosition, PortfolioAutoTrade.position_id == PortfolioPosition.id)
                        .where(PortfolioAutoTrade.status == "PENDING")
                        .where(PortfolioPosition.market == mkt)
                    ).scalars().all()
                    at_ids = [at.id for at in pending]

                if not at_ids:
                    log.info(f"[{mkt}] No pending orders")
                    continue

                # Try to execute each; those not triggered will be cancelled below
                executed = set()
                for at_id in at_ids:
                    _execute_auto_trade(at_id)
                    # Check if it was executed
                    with session_scope() as s:
                        at = s.get(PortfolioAutoTrade, at_id)
                        if at and at.status == "EXECUTED":
                            executed.add(at_id)

                # Cancel remaining untriggered orders for this market
                cancelled_count = 0
                with session_scope() as s:
                    for at_id in at_ids:
                        if at_id in executed:
                            continue
                        at = s.get(PortfolioAutoTrade, at_id)
                        if at and at.status == "PENDING":
                            at.status = "CANCELLED"
                            cancelled_count += 1

                log.info(f"[{mkt}] Executed: {len(executed)}, Cancelled: {cancelled_count}")

            # Housekeeping: prune old checked keys (keep last 7 days)
            cutoff = (now_bj - _dt.timedelta(days=7)).date().isoformat()
            stale = [k for k in _auto_trade_checked if k[1] < cutoff]
            for k in stale:
                del _auto_trade_checked[k]

        except Exception as e:
            import logging
            logging.getLogger("auto_trade").error(f"Auto-trade checker error: {e}")


# Start auto-trade background checker
_auto_trade_thread = threading.Thread(target=_auto_trade_checker, daemon=True)
_auto_trade_thread.start()


def _indicator_cache_warmer():
    """Background thread: pre-warm indicator cache for all portfolio positions.
    Runs once on startup (after 10s delay) then every hour.
    This ensures /api/portfolio/positions always has strategy data from cache."""
    import logging
    log = logging.getLogger("indicator_warmer")
    time.sleep(10)  # wait for app startup
    while True:
        try:
            with session_scope() as s:
                rows = s.execute(select(PortfolioPosition)).scalars().all()
                symbols = [(
                    (r.symbol or "").strip().upper(),
                    (r.market or "CN").strip().upper()
                ) for r in rows]
            if symbols:
                log.info(f"Pre-warming indicator cache for {len(symbols)} positions")
                for sym, mkt in symbols:
                    try:
                        get_stock_indicators(symbol=sym, market=mkt)
                    except Exception as e:
                        log.warning(f"Indicator warm failed for {sym}/{mkt}: {e}")
                log.info("Indicator cache warm complete")
            else:
                log.info("No positions to warm")
        except Exception as e:
            log.error(f"Indicator warmer error: {e}")
        time.sleep(3600)  # repeat every hour


if (os.environ.get("ENABLE_INDICATOR_WARMER") or "").strip() == "1":
    _indicator_warmer_thread = threading.Thread(target=_indicator_cache_warmer, daemon=True)
    _indicator_warmer_thread.start()


@app.get("/api/portfolio/alerts", response_model=list[PortfolioAlertResponse])
def get_portfolio_alerts():
    alerts: list[PortfolioAlertResponse] = []

    with session_scope() as s:
        positions = s.execute(select(PortfolioPosition)).scalars().all()

    for p in positions:
        market = (p.market or "CN").strip().upper()
        symbol = (p.symbol or "").strip().upper()
        name = (p.name or "").strip() or None

        sp = None
        try:
            sp = get_stock_price(symbol=symbol, market=market)
        except Exception:
            sp = None
        current_price = getattr(sp, "price", None) if sp is not None else None
        try:
            current_price = None if current_price is None else float(current_price)
        except Exception:
            current_price = None

        # User targets
        if current_price is not None and p.target_buy_price is not None:
            try:
                tb = float(p.target_buy_price)
                if current_price <= tb:
                    alerts.append(
                        PortfolioAlertResponse(
                            key=f"{p.id}:target_buy:{int(tb * 10000)}",
                            position_id=p.id,
                            market=market,
                            symbol=symbol,
                            name=name,
                            alert_type="target_buy",
                            message=f"已到达目标买入价 {tb:.2f}",
                            current_price=current_price,
                            trigger_price=tb,
                        )
                    )
            except Exception:
                pass

        if current_price is not None and p.target_sell_price is not None:
            try:
                ts = float(p.target_sell_price)
                if current_price >= ts:
                    alerts.append(
                        PortfolioAlertResponse(
                            key=f"{p.id}:target_sell:{int(ts * 10000)}",
                            position_id=p.id,
                            market=market,
                            symbol=symbol,
                            name=name,
                            alert_type="target_sell",
                            message=f"已到达目标卖出价 {ts:.2f}",
                            current_price=current_price,
                            trigger_price=ts,
                        )
                    )
            except Exception:
                pass

        # Strategy signals
        try:
            si = get_stock_indicators(symbol=symbol, market=market)
        except Exception:
            si = None

        if si is not None:
            if getattr(si, "buy_price_aggressive_ok", None) is True and getattr(si, "buy_price_aggressive", None) is not None:
                bp = getattr(si, "buy_price_aggressive", None)
                try:
                    bp = float(bp)
                except Exception:
                    bp = None
                alerts.append(
                    PortfolioAlertResponse(
                        key=f"{p.id}:signal_buy",
                        position_id=p.id,
                        market=market,
                        symbol=symbol,
                        name=name,
                        alert_type="signal_buy",
                        message=f"出现买入信号（参考价 {('-' if bp is None else f'{bp:.2f}')}）",
                        current_price=current_price,
                        trigger_price=bp,
                    )
                )

            if getattr(si, "sell_price_ok", None) is True and getattr(si, "sell_price", None) is not None:
                spx = getattr(si, "sell_price", None)
                try:
                    spx = float(spx)
                except Exception:
                    spx = None
                alerts.append(
                    PortfolioAlertResponse(
                        key=f"{p.id}:signal_sell",
                        position_id=p.id,
                        market=market,
                        symbol=symbol,
                        name=name,
                        alert_type="signal_sell",
                        message=f"出现卖出信号（参考价 {('-' if spx is None else f'{spx:.2f}')}）",
                        current_price=current_price,
                        trigger_price=spx,
                    )
                )

    return alerts


@app.get("/api/portfolio/{position_id}/ai-advice")
def get_portfolio_ai_advice(position_id: str):
    """Generate AI expert advice for a portfolio position, combining buy cost, indicators, and market data.
    All advice is strictly based on real-time data passed in the prompt — no training-data knowledge allowed.
    """
    import os
    from datetime import datetime, timezone, timedelta

    with session_scope() as s:
        p = s.get(PortfolioPosition, position_id)
        if not p:
            raise HTTPException(status_code=404, detail="position not found")
        market = (p.market or "CN").strip().upper()
        symbol = (p.symbol or "").strip().upper()
        name = (p.name or "").strip() or symbol
        quantity = float(p.quantity or 0)
        avg_cost = float(p.avg_cost or 0)

    now_dt = datetime.now(timezone(timedelta(hours=8)))
    today_str = now_dt.strftime("%Y-%m-%d %H:%M")

    # Fetch current price (real-time)
    sp = None
    current_price = None
    try:
        sp = get_stock_price(symbol=symbol, market=market)
        current_price = float(sp.price) if sp and sp.price is not None else None
    except Exception:
        pass

    # Fetch indicators (computed from real-time data)
    si = None
    try:
        si = get_stock_indicators(symbol=symbol, market=market)
    except Exception:
        pass

    # Build context — all real-time data
    cost_total = avg_cost * quantity if quantity > 0 else 0
    market_val = (current_price or 0) * quantity
    pnl = market_val - cost_total if current_price and quantity > 0 else None
    pnl_pct = (pnl / cost_total * 100) if pnl is not None and cost_total > 0 else None

    # Helper: read from dict or object attribute (get_stock_indicators / get_stock_price
    # may return dict or Pydantic model depending on call context)
    def _g(obj, key, default=None):
        if obj is None:
            return default
        if isinstance(obj, dict):
            return obj.get(key, default)
        return getattr(obj, key, default)

    def _safe(v, fmt=".2f"):
        if v is None:
            return "N/A"
        try:
            return f"{float(v):{fmt}}"
        except Exception:
            return str(v)

    lines = [
        f"数据获取时间: {today_str} (北京时间，以下所有数据均为此刻实时数据)",
        "",
        "=== 持仓信息 ===",
        f"股票名称: {name}",
        f"代码: {symbol}",
        f"市场: {market}",
        f"持仓数量: {quantity}",
        f"买入均价: {_safe(avg_cost, '.4f')}" if avg_cost > 0 else "买入均价: 未记录（尚未模拟买入）",
        f"当前实时价格: {_safe(current_price, '.4f')}" if current_price else "当前实时价格: 未获取",
    ]
    if pnl is not None:
        lines.append(f"浮动盈亏: {pnl:+.2f} ({pnl_pct:+.2f}%)")

    # Real-time intraday data from price API
    if sp:
        lines += [
            "",
            "=== 今日实时行情 ===",
            f"今日开盘: {_safe(_g(sp, 'open'))}",
            f"今日最高: {_safe(_g(sp, 'high'))}",
            f"今日最低: {_safe(_g(sp, 'low'))}",
            f"昨日收盘: {_safe(_g(sp, 'prev_close'))}",
            f"今日涨跌额: {_safe(_g(sp, 'change'))}",
            f"今日涨跌幅: {_safe(_g(sp, 'change_pct'))}%",
            f"成交量: {_safe(_g(sp, 'volume'), '.0f')}",
            f"成交额: {_safe(_g(sp, 'amount'), '.0f')}",
            f"换手率: {_safe(_g(sp, 'turnover_rate'))}%",
            f"量比: {_safe(_g(sp, 'volume_ratio'))}",
            f"振幅: {_safe(_g(sp, 'amplitude'))}%",
            f"总市值: {_safe(_g(sp, 'market_cap'), '.0f')}",
        ]

    if si:
        def _v(attr, fmt=".2f"):
            v = _g(si, attr)
            if v is None:
                return "N/A"
            try:
                return f"{float(v):{fmt}}"
            except Exception:
                return str(v)

        def _bool(attr):
            v = _g(si, attr)
            if v is True:
                return '是'
            if v is False:
                return '否'
            return '否'

        # Position relative to 52-week range
        pos_52w = ""
        h52 = _g(si, 'high_52w')
        l52 = _g(si, 'low_52w')
        if current_price and h52 and l52 and h52 != l52:
            try:
                pct_in_range = (current_price - float(l52)) / (float(h52) - float(l52)) * 100
                pos_52w = f"  (当前处于52周区间的 {pct_in_range:.0f}% 位置)"
            except Exception:
                pass

        lines += [
            "",
            "=== 技术指标（基于最新收盘数据计算） ===",
            f"MA5(5日均线): {_v('ma5')}",
            f"MA20(20日均线): {_v('ma20')}",
            f"MA60(60日均线): {_v('ma60')}",
            f"均线趋势判定: {_g(si, 'trend', 'N/A')}",
            f"MA60斜率: {_v('slope_pct')}%",
            f"斜率建议: {_g(si, 'slope_advice', 'N/A')}",
            f"RSI(14): {_v('rsi14')}  (>70超买, <30超卖)",
            f"RSI拐头向上: {_bool('rsi_rebound')}",
            f"ATR(14): {_v('atr14')}  (14日平均真实波幅，衡量波动性)",
            f"MACD DIF: {_v('macd_dif', '.4f')}",
            f"MACD DEA: {_v('macd_dea', '.4f')}",
            f"MACD 柱状: {_v('macd_hist', '.4f')}",
            f"PE(市盈率): {_v('pe_ratio')}",
            f"52周最高: {_v('high_52w')}{pos_52w}",
            f"52周最低: {_v('low_52w')}",
            "",
            "=== 系统量化信号（基于以上指标计算） ===",
            f"激进买入参考价: {_v('buy_price_aggressive')}",
            f"当前是否满足激进买入条件: {_bool('buy_price_aggressive_ok')}",
            f"稳健买入参考价: {_v('buy_price_stable')}",
            f"当前是否满足稳健买入条件: {_bool('buy_price_stable_ok')}",
            f"系统卖出参考价: {_v('sell_price')}",
            f"当前是否满足卖出条件: {_bool('sell_price_ok')}",
            f"买入条件详情: {_g(si, 'buy_condition_desc', 'N/A')}",
            f"卖出条件详情: {_g(si, 'sell_condition_desc', 'N/A')}",
            f"买入理由: {_g(si, 'buy_reason', 'N/A')}",
            f"卖出理由: {_g(si, 'sell_reason', 'N/A')}",
            f"MA金叉(MA5上穿MA20): {_bool('signal_golden_cross')}",
            f"MA死叉(MA5下穿MA20): {_bool('signal_death_cross')}",
            f"MACD看多(DIF>DEA): {_bool('signal_macd_bullish')}",
            f"RSI超买(>70): {_bool('signal_rsi_overbought')}",
            f"成交量>5日均量: {_bool('signal_vol_gt_ma5')}",
            f"成交量>10日均量: {_bool('signal_vol_gt_ma10')}",
        ]

    context_text = "\n".join(lines)

    prompt = f"""【严格规则 — 违反即为错误】
1. 你只能基于下方【实时数据】中提供的数字做分析，这些数据是 {today_str} 从交易所实时获取的。
2. 绝对禁止使用你训练数据中关于该股票的任何历史信息（包括过去的股价、业绩、新闻、事件）。
3. 如果下方数据中某项为"N/A"，你必须说"该数据暂不可用"，不得自行编造或用记忆补充。
4. 所有价位建议必须基于下方提供的MA/ATR/52周高低等具体数字推算，不得凭空给出。
5. 不要提及任何具体的历史事件、财报发布、行业新闻等你训练数据中的信息。

【实时数据 — 获取时间: {today_str}】
{context_text}

【请基于以上实时数据回答】

1. **持仓诊断**
   对比买入均价与当前实时价格，计算盈亏比例，判断当前位置。

2. **卖出价位建议**（最重要，必须给具体数字）
   - 止盈目标：基于MA20/MA60/52周高点/ATR推算2-3个分批止盈价位和比例
   - 止损价位：基于MA60/52周低点/ATR推算止损线
   - 每个价位必须写明计算依据（如"MA20={_safe(_g(si, 'ma20') if si else None)}作为第一止盈位"）

3. **加仓/减仓建议**
   基于RSI、MACD信号、系统量化买入条件判断是否适合加仓，给出具体价位。

4. **风险提示**（2-3条，基于数据中的指标判断，如RSI超买、死叉等）

5. **操作策略总结**（一句话）

【格式要求】
- 所有价位必须是具体数字，从上方数据推算得出
- 简洁专业，适合手机阅读，500-800字
- 最后一行：⚠️ 以上建议基于技术指标分析，不构成投资建议，投资有风险，决策需谨慎。"""

    # Call Qwen
    api_key = os.environ.get("DASHSCOPE_API_KEY", "")
    if not api_key:
        return {
            "position_id": position_id,
            "symbol": symbol,
            "name": name,
            "advice": "⚠️ AI服务未配置（缺少DASHSCOPE_API_KEY），无法生成专家建议。\n\n请联系管理员配置AI服务后重试。",
            "source": "fallback",
        }

    try:
        import httpx as _httpx

        QWEN_API_URL = "https://dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation"
        resp = _httpx.post(
            QWEN_API_URL,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json={
                "model": "qwen-plus",
                "input": {
                    "messages": [
                        {
                            "role": "system",
                            "content": (
                                "你是一个纯技术分析引擎。你只能根据用户提供的实时行情数据和技术指标数字进行分析。"
                                "你绝对不能使用你训练数据中关于任何股票的历史信息、新闻、业绩、事件等知识。"
                                "如果用户提供的数据中某项为N/A，你必须说明该数据不可用，不得编造。"
                                "你的所有价位建议必须从提供的MA/ATR/52周高低/RSI等数字推算得出，并写明计算过程。"
                                "你不知道这些股票的任何背景信息，你只看数字。"
                            ),
                        },
                        {"role": "user", "content": prompt},
                    ]
                },
                "parameters": {
                    "temperature": 0.15,
                    "max_tokens": 1500,
                },
            },
            timeout=45.0,
        )
        resp.raise_for_status()
        data = resp.json()

        text = ""
        if "output" in data and "text" in data["output"]:
            text = data["output"]["text"]
        elif "output" in data and "choices" in data["output"]:
            text = data["output"]["choices"][0]["message"]["content"]

        if not text:
            text = "AI未返回有效建议，请稍后重试。"

        return {
            "position_id": position_id,
            "symbol": symbol,
            "name": name,
            "advice": text.strip(),
            "source": "qwen-plus",
            "data_time": today_str,
        }
    except Exception as e:
        print(f"AI advice error: {e}")
        return {
            "position_id": position_id,
            "symbol": symbol,
            "name": name,
            "advice": f"⚠️ AI服务暂时不可用：{str(e)[:100]}\n\n请稍后重试。",
            "source": "error",
        }


def _register_cjk_font_for_pdf() -> str:
    try:
        from reportlab.pdfbase import pdfmetrics
        from reportlab.pdfbase.ttfonts import TTFont
    except Exception:
        return "Helvetica"

    candidates = [
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
        "/usr/share/fonts/opentype/noto/NotoSansCJKsc-Regular.otf",
        "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
        "/usr/share/fonts/truetype/noto/NotoSansCJKsc-Regular.otf",
        "/usr/share/fonts/truetype/arphic/ukai.ttc",
        "/usr/share/fonts/truetype/arphic/uming.ttc",
        "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
        "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",
    ]

    for fp in candidates:
        try:
            if fp and Path(fp).exists():
                font_name = "CJKFont"
                pdfmetrics.registerFont(TTFont(font_name, fp))
                return font_name
        except Exception:
            continue
    return "Helvetica"


def _build_report_pdf_bytes(report: Report, metrics: list[ComputedMetric], alerts: list[Alert]) -> bytes:
    try:
        from reportlab.lib.pagesizes import A4
        from reportlab.lib.styles import getSampleStyleSheet
        from reportlab.lib.enums import TA_LEFT
        from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle
        from reportlab.lib import colors
    except Exception as e:
        raise RuntimeError(f"reportlab_import_failed:{e}")

    cjk_font = _register_cjk_font_for_pdf()

    buf = BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=A4, leftMargin=36, rightMargin=36, topMargin=36, bottomMargin=36)
    styles = getSampleStyleSheet()
    try:
        styles["Title"].fontName = cjk_font
        styles["Normal"].fontName = cjk_font
        styles["Heading2"].fontName = cjk_font
        styles["Heading3"].fontName = cjk_font
        styles["Normal"].alignment = TA_LEFT
    except Exception:
        pass

    story = []
    title = getattr(report, "report_name", None) or "分析报告"
    story.append(Paragraph(str(title), styles["Title"]))

    meta_lines: list[str] = []
    if getattr(report, "source_type", None):
        meta_lines.append(f"来源：{report.source_type}")
    if getattr(report, "status", None):
        meta_lines.append(f"状态：{report.status}")
    if getattr(report, "period_end", None):
        meta_lines.append(f"报告期：{report.period_end}")
    if getattr(report, "market", None):
        meta_lines.append(f"市场：{report.market}")
    if meta_lines:
        story.append(Spacer(1, 8))
        story.append(Paragraph("<br/>".join(meta_lines), styles["Normal"]))

    story.append(Spacer(1, 12))

    # ====== Helpers ======
    def _fmt(v: float | None, digits: int = 2) -> str:
        if v is None:
            return "-"
        try:
            return f"{float(v):.{digits}f}"
        except Exception:
            return "-"

    def _value(code: str) -> float | None:
        m = latest_map.get(code)
        if not m:
            return None
        try:
            return None if m.value is None else float(m.value)
        except Exception:
            return None

    # Latest period selection
    metrics_sorted = sorted(metrics or [], key=lambda m: str(getattr(m, "period_end", "") or ""), reverse=True)
    latest_period = (getattr(report, "period_end", None) or "").strip() or (metrics_sorted[0].period_end if metrics_sorted else None)
    latest_metrics = [m for m in (metrics or []) if latest_period and m.period_end == latest_period]
    latest_map = {str(m.metric_code or ""): m for m in latest_metrics}

    gross_margin = _value("GROSS_MARGIN")
    net_margin = _value("NET_MARGIN")
    roe = _value("ROE")
    roa = _value("ROA")
    current_ratio = _value("CURRENT_RATIO")
    debt_ratio = _value("DEBT_ASSET")
    quick_ratio = _value("QUICK_RATIO")
    asset_turnover = _value("ASSET_TURNOVER")
    inv_turnover = _value("INVENTORY_TURNOVER")
    recv_turnover = _value("RECEIVABLE_TURNOVER")
    revenue_growth = _value("REVENUE_GROWTH")
    profit_growth = _value("PROFIT_GROWTH")
    operating_cash_flow = _value("OPERATING_CASH_FLOW")

    try:
        from rating_engine import compute_enterprise_rating
        _rating = compute_enterprise_rating(
            net_margin=net_margin,
            gross_margin=gross_margin,
            roe=roe,
            roa=roa,
            debt_ratio=debt_ratio,
            current_ratio=current_ratio,
            asset_turnover=asset_turnover,
            inv_turnover=inv_turnover,
            recv_turnover=recv_turnover,
            revenue_growth=revenue_growth,
            profit_growth=profit_growth,
            operating_cash_flow=operating_cash_flow,
            net_profit=_value("NET_PROFIT") if _value("NET_PROFIT") else None,
            gross_margin_3y=None,
        )
    except Exception:
        _rating = None

    # Same heuristic constants as frontend
    industry_avg = {
        "grossMargin": 35.0,
        "netMargin": 10.0,
        "roe": 15.0,
        "roa": 8.0,
        "currentRatio": 1.5,
        "debtRatio": 50.0,
        "assetTurnover": 0.8,
    }

    # ====== Overview ======
    story.append(Paragraph("概览", styles["Heading2"]))
    overview_rows = [
        ["关键指标", "数值"],
        ["毛利率", ("-" if gross_margin is None else f"{_fmt(gross_margin)}%")],
        ["净利率", ("-" if net_margin is None else f"{_fmt(net_margin)}%")],
        ["ROE", ("-" if roe is None else f"{_fmt(roe)}%")],
        ["ROA", ("-" if roa is None else f"{_fmt(roa)}%")],
        ["流动比率", _fmt(current_ratio)],
        ["速动比率", _fmt(quick_ratio)],
        ["资产负债率", ("-" if debt_ratio is None else f"{_fmt(debt_ratio)}%")],
    ]
    tbl0 = Table(overview_rows, repeatRows=1, hAlign="LEFT", colWidths=[160, 190])
    tbl0.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#f0f2f6")),
                ("GRID", (0, 0), (-1, -1), 0.3, colors.HexColor("#d0d7de")),
                ("FONTNAME", (0, 0), (-1, -1), cjk_font),
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ]
        )
    )
    story.append(tbl0)

    story.append(Spacer(1, 10))
    lvl_counts = {"high": 0, "medium": 0, "low": 0}
    for a in alerts or []:
        lvl = str(getattr(a, "level", "") or "").lower()
        if lvl in lvl_counts:
            lvl_counts[lvl] += 1
    story.append(Paragraph(f"风险预警：高风险 {lvl_counts['high']} 条，中风险 {lvl_counts['medium']} 条，低风险 {lvl_counts['low']} 条", styles["Normal"]))

    story.append(Spacer(1, 12))

    # ====== Financial metrics (all periods) ======
    story.append(Paragraph("财务指标", styles["Heading2"]))
    if not metrics:
        story.append(Paragraph("暂无财务指标数据", styles["Normal"]))
    else:
        rows = [["指标", "数值", "单位", "报告期"]]
        for m in metrics_sorted:
            try:
                v = None if m.value is None else float(m.value)
            except Exception:
                v = None
            vstr = "-" if v is None else f"{v:.4g}"
            rows.append([str(m.metric_name or m.metric_code), vstr, str(m.unit or ""), str(m.period_end or "")])
        rows = rows[:1 + min(80, max(0, len(rows) - 1))]
        tbl = Table(rows, repeatRows=1, hAlign="LEFT", colWidths=[150, 80, 40, 70])
        tbl.setStyle(
            TableStyle(
                [
                    ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#f0f2f6")),
                    ("GRID", (0, 0), (-1, -1), 0.3, colors.HexColor("#d0d7de")),
                    ("FONTNAME", (0, 0), (-1, -1), cjk_font),
                    ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                ]
            )
        )
        story.append(tbl)

    story.append(Spacer(1, 12))

    # ====== Risk analysis (professional framework) ======
    story.append(Paragraph("专业风险评估框架", styles["Heading2"]))
    story.append(Paragraph("参考穆迪/标普评级方法论，从多维度系统评估企业风险", styles["Normal"]))
    story.append(Spacer(1, 6))

    # 1. DuPont
    story.append(Paragraph("1. 杜邦分解分析 (DuPont Analysis)", styles["Heading3"]))
    if net_margin is not None:
        txt = f"净利率 {_fmt(net_margin)}%" + ("，高于行业均值，但需警惕是否依赖非经常性损益（资产处置、政府补贴、投资收益）支撑。" if net_margin > industry_avg["netMargin"] else "，低于行业均值，表明费用控制或定价能力存在压力，需关注销售费用率、管理费用率的变动趋势。")
        story.append(Paragraph(f"• 净利率驱动：{txt}", styles["Normal"]))
    if asset_turnover is not None:
        txt = f"总资产周转率 {_fmt(asset_turnover)}" + ("，低于行业水平，可能存在产能过剩、固定资产利用率不足或应收/存货占比过高的问题。" if asset_turnover < industry_avg["assetTurnover"] else "，处于行业正常水平，资产利用效率尚可。")
        story.append(Paragraph(f"• 资产周转驱动：{txt}", styles["Normal"]))
    if debt_ratio is not None:
        eq_mult = 100 / max(1, 100 - debt_ratio)
        txt = f"资产负债率 {_fmt(debt_ratio)}%，权益乘数约 {eq_mult:.2f}x。" + ("高杠杆虽可放大ROE，但在利率上行周期或营收下滑时，利息覆盖倍数可能快速恶化。" if debt_ratio > 60 else "杠杆水平适中，财务弹性较好。")
        story.append(Paragraph(f"• 财务杠杆驱动：{txt}", styles["Normal"]))
    story.append(Spacer(1, 6))

    # 2. Liquidity
    story.append(Paragraph("2. 流动性与偿债能力", styles["Heading3"]))
    if current_ratio is not None:
        if current_ratio < 1:
            txt = f"流动比率 {_fmt(current_ratio)}，流动资产不足以覆盖流动负债，存在短期偿债缺口。建议关注银行授信额度和短期融资渠道。"
        elif current_ratio > 3:
            txt = f"流动比率 {_fmt(current_ratio)}，偏高，虽然偿债无忧，但大量资金闲置可能拉低资本回报率。"
        else:
            txt = f"流动比率 {_fmt(current_ratio)}，短期偿债能力处于合理区间，需持续监控应收账款账龄和存货跌价风险。"
        story.append(Paragraph(f"• 短期偿债：{txt}", styles["Normal"]))
    if debt_ratio is not None:
        if debt_ratio > 70:
            txt = f"资产负债率 {_fmt(debt_ratio)}%，高负债率意味着在经济下行期可能面临银行抽贷、再融资成本上升等连锁风险。"
        elif debt_ratio < 30:
            txt = f"资产负债率 {_fmt(debt_ratio)}%，极低的负债率表明财务极为保守，几乎无债务违约风险。"
        else:
            txt = f"资产负债率 {_fmt(debt_ratio)}%，处于可控区间，建议关注有息负债占比和债务期限结构。"
        story.append(Paragraph(f"• 资本结构：{txt}", styles["Normal"]))
    story.append(Spacer(1, 6))

    # 3. Operating Quality
    story.append(Paragraph("3. 营运质量与周转风险", styles["Heading3"]))
    if inv_turnover is not None:
        txt = f"存货周转率 {_fmt(inv_turnover)} 次。" + ("周转偏慢，可能面临存货跌价、产品过时或滞销风险。" if inv_turnover < 4 else "存货周转效率尚可，建议对比同行业竞争对手的周转水平。")
        story.append(Paragraph(f"• 存货管理：{txt}", styles["Normal"]))
    if recv_turnover is not None:
        days = 365 / recv_turnover if recv_turnover > 0 else 999
        txt = f"应收账款周转率 {_fmt(recv_turnover)} 次（约 {days:.0f} 天回款周期）。" + ("回款周期超过60天，需警惕客户信用风险和坏账计提不足。" if recv_turnover < 6 else "回款效率尚可。")
        story.append(Paragraph(f"• 应收账款：{txt}", styles["Normal"]))
    story.append(Spacer(1, 6))

    # 4. Growth Sustainability
    story.append(Paragraph("4. 增长可持续性风险", styles["Heading3"]))
    if roe is not None and net_margin is not None:
        sgr = roe * 0.7
        txt = f"ROE {_fmt(roe)}%，可持续增长率(SGR)约 {_fmt(sgr)}%（假设70%留存率）。"
        if gross_margin is not None and gross_margin > 50 and net_margin > 20:
            txt += " 作为高利润率企业，未来增长面临基数效应挑战，需不断开拓新市场或推出新产品线。"
        elif net_margin < 5:
            txt += " 低利润率限制了内生增长能力，企业可能需要依赖外部融资支撑扩张。"
        else:
            txt += " 盈利水平支撑一定的内生增长能力，但需关注行业竞争格局变化对利润率的侵蚀。"
        story.append(Paragraph(f"• {txt}", styles["Normal"]))
    else:
        story.append(Paragraph("• 关键盈利指标缺失，无法评估增长可持续性。", styles["Normal"]))

    # Alert details
    if alerts:
        story.append(Spacer(1, 8))
        story.append(Paragraph("系统风险预警明细", styles["Heading3"]))
        for a in alerts:
            lvl = getattr(a, "level", "") or ""
            ttl = getattr(a, "title", "") or ""
            msg = getattr(a, "message", "") or ""
            story.append(Paragraph(f"[{lvl}] {ttl}", styles["Normal"]))
            story.append(Paragraph(str(msg).replace("\n", "<br/>") or "-", styles["Normal"]))
            story.append(Spacer(1, 4))

    story.append(Spacer(1, 12))

    # ====== Opportunities (professional framework) ======
    story.append(Paragraph("投资机会识别框架", styles["Heading2"]))
    story.append(Paragraph("参考高盛/摩根士丹利研究方法论，从竞争壁垒、价值创造、资本优化三大维度识别机会", styles["Normal"]))
    story.append(Spacer(1, 6))

    # 1. Competitive Moat
    story.append(Paragraph("1. 竞争壁垒与护城河", styles["Heading3"]))
    if gross_margin is not None:
        if gross_margin >= 40:
            txt = f"毛利率 {_fmt(gross_margin)}%，高毛利率（>40%）通常意味着企业拥有较强的品牌溢价、技术壁垒或网络效应。参考晨星'宽护城河'标准，持续高毛利率是竞争优势的核心体现。"
        elif gross_margin >= industry_avg["grossMargin"]:
            txt = f"毛利率 {_fmt(gross_margin)}%，高于行业均值，表明具备一定的产品差异化或成本优势。"
        else:
            txt = f"毛利率 {_fmt(gross_margin)}%，低于行业均值，但若企业正处于市场扩张期，未来随着规模效应释放，毛利率存在改善空间。"
        story.append(Paragraph(f"• 定价权：{txt}", styles["Normal"]))
    if net_margin is not None and gross_margin is not None:
        expense_rate = gross_margin - net_margin
        txt = f"费用率约 {_fmt(expense_rate)}%。" + ("费用率控制良好，表明企业运营效率较高。" if expense_rate < 20 else "费用率偏高，但若处于研发投入期或渠道扩张期，可能是为未来增长播种。")
        story.append(Paragraph(f"• 成本效率：{txt}", styles["Normal"]))
    story.append(Spacer(1, 6))

    # 2. Value Creation
    story.append(Paragraph("2. 价值创造能力", styles["Heading3"]))
    if roe is not None:
        if roe > 20:
            txt = f"ROE {_fmt(roe)}%，优秀的ROE（>20%）表明企业正在为股东创造显著超额回报。参考巴菲特选股标准，持续ROE>20%的企业通常具备经济特许权。"
        elif roe > industry_avg["roe"]:
            txt = f"ROE {_fmt(roe)}%，高于行业均值{industry_avg['roe']}%，资本回报效率较好，具备长期复利潜力。"
        else:
            txt = f"ROE {_fmt(roe)}%，低于行业均值{industry_avg['roe']}%，但若企业正处于转型期，未来ROE存在较大提升空间。"
        story.append(Paragraph(f"• 股东价值：{txt}", styles["Normal"]))
    if roa is not None:
        txt = f"ROA {_fmt(roa)}%。" + ("资产回报率高于行业水平，表明企业资产质量较好、运营效率较高。" if roa > industry_avg["roa"] else "ROA低于行业水平，可能存在资产利用效率不足的问题。")
        story.append(Paragraph(f"• 资产创利：{txt}", styles["Normal"]))
    story.append(Spacer(1, 6))

    # 3. Capital Optimization
    story.append(Paragraph("3. 资本结构优化空间", styles["Heading3"]))
    if debt_ratio is not None:
        if debt_ratio < 40:
            txt = f"资产负债率 {_fmt(debt_ratio)}%，较低的负债率意味着企业拥有充足的融资弹药。适度增加杠杆可以利用税盾效应降低加权资本成本(WACC)。"
        elif debt_ratio < industry_avg["debtRatio"]:
            txt = f"资产负债率 {_fmt(debt_ratio)}%，低于行业均值，财务结构稳健，在行业整合期具备更强的抗风险能力和并购扩张能力。"
        else:
            txt = f"资产负债率 {_fmt(debt_ratio)}%，高于行业均值，但若企业现金流稳定且利息覆盖充足，适度杠杆可以放大股东回报。"
        story.append(Paragraph(f"• 杠杆优化：{txt}", styles["Normal"]))

    story.append(Spacer(1, 12))

    # ====== AI Insights (professional, consistent with frontend) ======
    story.append(Paragraph("AI 综合研判", styles["Heading2"]))
    story.append(Paragraph("参考CFA研究框架，融合定量分析与定性判断", styles["Normal"]))
    story.append(Spacer(1, 6))

    if metrics_sorted:
        # Scorecard
        def _grade(val: float | None, thresholds: list[tuple[float, str]], reverse: bool = False) -> str:
            if val is None:
                return "-"
            for t, g in thresholds:
                if (not reverse and val > t) or (reverse and val < t):
                    return g
            return thresholds[-1][1] if thresholds else "C"

        if _rating is not None:
            r = _rating
            story.append(Paragraph(f"企业综合评级：{r['grade']} {r['total_score']}/100", styles["Normal"]))
            story.append(Paragraph(f"评级建议：{r['recommendation']}", styles["Normal"]))
            story.append(Spacer(1, 4))
            dim_rows = [["维度", "评分", "强度", "权重"]]
            for label, d in r["dim_summary"].items():
                dim_rows.append([label, f"{d['score']}/25", d["flag"], f"{d['weight']*100:.0f}%"])
            dim_tbl = Table(dim_rows, repeatRows=1, hAlign="LEFT", colWidths=[100, 60, 40, 50])
            dim_tbl.setStyle(TableStyle([
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#f0f2f6")),
                ("GRID", (0, 0), (-1, -1), 0.3, colors.HexColor("#d0d7de")),
                ("FONTNAME", (0, 0), (-1, -1), cjk_font),
                ("FONTSIZE", (0, 0), (-1, -1), 9),
            ]))
            story.append(dim_tbl)
            story.append(Spacer(1, 4))
            if r["strengths"]:
                story.append(Paragraph("优势：" + "、".join(r["strengths"]), styles["Normal"]))
            if r["risks"]:
                story.append(Paragraph("风险：" + "、".join(r["risks"]), styles["Normal"]))
        story.append(Spacer(1, 6))

        # Profitability
        if gross_margin is not None and net_margin is not None:
            expense = gross_margin - net_margin
            detail = f"毛利率 {_fmt(gross_margin, 1)}%，净利率 {_fmt(net_margin, 1)}%，费用消耗率 {_fmt(expense, 1)}%。"
            if net_margin > 20:
                detail += " 净利率超过20%属于优质盈利水平，需重点验证高利润是否来自核心业务而非一次性收益。"
            elif net_margin > 10:
                detail += " 净利率处于中等偏上水平，建议关注费用率是否有优化空间。"
            else:
                detail += " 净利率偏低，需分析是行业特性还是竞争力不足。"
            story.append(Paragraph(f"• 盈利质量：{detail}", styles["Normal"]))

        # DuPont
        if roe is not None and roa is not None:
            detail = f"ROE {_fmt(roe, 1)}%，ROA {_fmt(roa, 1)}%。"
            if roe > 15 and roa > 8:
                detail += " 高ROE且高ROA表明企业通过经营能力而非财务杠杆创造回报，这是最健康的盈利模式。"
            elif roe > 15:
                detail += " ROE较高但ROA偏低，说明高ROE主要依赖财务杠杆放大，下行期风险会被同步放大。"
            else:
                detail += " ROE和ROA均处于一般水平，建议从杜邦三因素中寻找最大改善空间。"
            story.append(Paragraph(f"• 杜邦分解：{detail}", styles["Normal"]))

        # Financial Health
        if debt_ratio is not None and current_ratio is not None:
            detail = f"资产负债率 {_fmt(debt_ratio, 1)}%，流动比率 {_fmt(current_ratio, 2)}。"
            if debt_ratio < 50 and current_ratio > 1.5:
                detail += " 财务结构稳健，短期偿债能力充足，企业拥有充足的财务弹性。"
            elif debt_ratio > 65:
                detail += " 负债率偏高，需密切关注有息负债占比、短期债务占比和经营性现金流覆盖能力。"
            else:
                detail += " 财务结构处于中等水平，建议关注债务期限结构和利率敏感性。"
            story.append(Paragraph(f"• 财务稳健性：{detail}", styles["Normal"]))

        # Operating Efficiency
        if asset_turnover is not None:
            detail = f"总资产周转率 {_fmt(asset_turnover)}。"
            if inv_turnover is not None:
                detail += f" 存货周转 {_fmt(inv_turnover)} 次（{365/inv_turnover:.0f}天）。"
            if recv_turnover is not None:
                detail += f" 应收周转 {_fmt(recv_turnover)} 次（{365/recv_turnover:.0f}天）。"
            detail += " 运营效率直接影响现金转化周期——周转越快，企业对外部融资的依赖越低。"
            story.append(Paragraph(f"• 运营效率：{detail}", styles["Normal"]))

        story.append(Spacer(1, 6))

        # Investment Thesis
        story.append(Paragraph("投资论点与建议", styles["Heading3"]))
        if roe is not None and roe > 20:
            story.append(Paragraph(f"• [看多] ROE {_fmt(roe)}% 显著高于资本成本，企业正在为股东创造超额价值。", styles["Normal"]))
        if gross_margin is not None and gross_margin > 40:
            story.append(Paragraph(f"• [看多] 高毛利率 {_fmt(gross_margin)}% 体现强定价权，在通胀环境下具备成本转嫁能力。", styles["Normal"]))
        if debt_ratio is not None and debt_ratio > 65:
            story.append(Paragraph(f"• [风险] 高负债率 {_fmt(debt_ratio)}% 在利率上行周期可能侵蚀利润。", styles["Normal"]))
        if current_ratio is not None and current_ratio < 1.2:
            story.append(Paragraph(f"• [风险] 流动比率 {_fmt(current_ratio)} 接近警戒线，短期偿债安全边际不足。", styles["Normal"]))
        if net_margin is not None and net_margin > 15:
            story.append(Paragraph(f"• [看多] 净利率 {_fmt(net_margin)}% 处于优秀水平。", styles["Normal"]))

        # Composite recommendation from rating engine
        if _rating is not None:
            story.append(Paragraph(f"• 综合建议：{_rating['recommendation']}（评级{_rating['grade']} {_rating['total_score']}分）", styles["Normal"]))
        else:
            story.append(Paragraph("• 暂无足够数据生成综合评级建议。", styles["Normal"]))
    else:
        story.append(Paragraph("暂无足够数据生成AI洞察，请确保报告已完成分析。", styles["Normal"]))

    story.append(Spacer(1, 12))

    # ====== Summary ======
    story.append(Paragraph("分析总结", styles["Heading2"]))
    summary_lines: list[str] = []
    if net_margin is not None:
        summary_lines.append(f"盈利质量：净利率 {_fmt(net_margin)}%（行业均值 {industry_avg['netMargin']}%）")
    if roe is not None:
        summary_lines.append(f"资本回报：ROE {_fmt(roe)}%（行业均值 {industry_avg['roe']}%）")
    if debt_ratio is not None:
        summary_lines.append(f"杠杆水平：资产负债率 {_fmt(debt_ratio)}%（关注 >70% 的再融资压力）")
    if current_ratio is not None:
        summary_lines.append(f"流动性：流动比率 {_fmt(current_ratio)}（关注 <1 的短期偿债风险）")
    if asset_turnover is not None:
        summary_lines.append(f"运营效率：总资产周转率 {_fmt(asset_turnover)}（行业均值 {industry_avg['assetTurnover']}）")
    if not summary_lines:
        summary_lines.append("关键指标不足，建议补齐财务数据后再进行结论性判断。")
    for s in summary_lines:
        story.append(Paragraph(f"• {s}", styles["Normal"]))

    doc.build(story)
    return buf.getvalue()


@app.get("/api/reports/{report_id}/export/pdf")
def export_report_pdf(report_id: str):
    report = get_report(report_id)
    if not report:
        raise HTTPException(status_code=404, detail="Report not found")

    with session_scope() as s:
        metrics = s.execute(select(ComputedMetric).where(ComputedMetric.report_id == report_id)).scalars().all()
        alerts = s.execute(select(Alert).where(Alert.report_id == report_id)).scalars().all()

    try:
        pdf_bytes = _build_report_pdf_bytes(report, metrics, alerts)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"export_pdf_failed:{str(e)}")

    from urllib.parse import quote
    import re

    safe_name = (getattr(report, "report_name", None) or "report")
    try:
        if safe_name and "%" in safe_name:
            safe_name = unquote(safe_name)
    except Exception:
        pass
    safe_name = safe_name.replace("/", "-").replace("\\", "-")
    filename = f"{safe_name}-{getattr(report, 'period_end', None) or 'period'}.pdf"

    # Starlette headers are latin-1 encoded; for non-ascii filenames use RFC 5987 filename*
    ascii_fallback = re.sub(r"[^A-Za-z0-9._-]+", "_", filename) or "report.pdf"
    quoted = quote(filename, safe="")
    content_disposition = f"attachment; filename=\"{ascii_fallback}\"; filename*=UTF-8''{quoted}"

    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={"Content-Disposition": content_disposition},
    )


@app.get("/api/alerts", response_model=list[AlertResponse])
def get_all_alerts(level: Optional[str] = None, limit: int = 50):
    """Get all alerts, optionally filtered by level."""
    with session_scope() as s:
        stmt = select(Alert).order_by(Alert.created_at.desc()).limit(limit)
        if level:
            stmt = stmt.where(Alert.level == level)
        alerts = s.execute(stmt).scalars().all()
        return [
            AlertResponse(
                id=a.id,
                alert_code=a.alert_code,
                level=a.level,
                title=a.title,
                message=a.message,
                period_end=a.period_end,
            )
            for a in alerts
        ]


@app.get("/api/alerts/summary")
def get_alerts_summary():
    """Get alerts summary by level."""
    with session_scope() as s:
        high = s.execute(select(func.count(Alert.id)).where(Alert.level == "high")).scalar() or 0
        medium = s.execute(select(func.count(Alert.id)).where(Alert.level == "medium")).scalar() or 0
        low = s.execute(select(func.count(Alert.id)).where(Alert.level == "low")).scalar() or 0
    return {"high": high, "medium": medium, "low": low}


def _get_stock_spot_data(market: str):
    """Get real-time stock data from akshare."""
    try:
        import time
        import pandas as pd

        market = (market or "CN").upper()

        ttl = float((os.environ.get("SPOT_CACHE_TTL_SECONDS") or "300").strip() or "300")
        cached = _SPOT_CACHE.get(market)
        if cached and (time.time() - float(cached[0])) < ttl:
            try:
                df0 = cached[1]
                if df0 is not None and not df0.empty:
                    return df0
            except Exception:
                pass

        disable_proxies_for_process()
        import akshare as ak
        
        out = None
        if market == "CN":
            out = ak.stock_zh_a_spot_em()
        elif market == "HK":
            out = ak.stock_hk_spot_em()
        elif market == "US":
            out = ak.stock_us_spot_em()
        if out is not None and not out.empty:
            _SPOT_CACHE[market] = (time.time(), out)
        return out
    except Exception as e:
        print(f"Error fetching stock data: {e}")
        return None


def _tencent_quote_code(symbol: str, market: str) -> str | None:
    import re

    s = (symbol or "").strip().upper()
    m = (market or "").strip().upper()
    if m == "CN":
        if "." in s:
            code, suffix = s.split(".", 1)
            suffix = suffix.upper()
            if suffix == "SH":
                return f"sh{code}"
            if suffix == "SZ":
                return f"sz{code}"
            if suffix == "BJ":
                return f"bj{code}"
        if s.isdigit() and len(s) == 6:
            return f"sh{s}" if s.startswith("6") else f"sz{s}"
        return None
    if m == "HK":
        code = s.replace(".HK", "")
        if code.isdigit():
            return f"hk{code.zfill(5)}"
        return None
    if m == "US":
        base = s.split(".", 1)[0]
        if re.fullmatch(r"[A-Z.\-]{1,10}", base):
            return f"us{base}"
        return None
    return None


def _tencent_fetch_quote(symbol: str, market: str) -> Optional["StockPriceResponse"]:
    try:
        q = _tencent_quote_code(symbol, market)
        if not q:
            return None

        disable_proxies_for_process()
        import httpx

        with httpx.Client(timeout=10, follow_redirects=True) as client:
            text = client.get(f"https://qt.gtimg.cn/q={q}").text

        if '"' not in text:
            return None
        payload = text.split('"', 2)[1]
        parts = payload.split("~")

        def _to_float(v):
            if v is None:
                return None
            if isinstance(v, str) and not v.strip():
                return None
            try:
                return float(v)
            except Exception:
                return None

        def _pick(i: int):
            if i < len(parts):
                return _to_float(parts[i])
            return None

        name = (parts[1] if len(parts) > 1 else "") or ""
        price = _pick(3)
        prev_close = _pick(4)
        open_p = _pick(5)
        high = _pick(33)
        low = _pick(34)
        volume = _pick(36)
        mkt = (market or "").upper()
        if mkt == "CN" and volume is not None:
            volume = volume * 100

        amount = None
        if len(parts) > 35 and parts[35]:
            seg = str(parts[35]).split("/")
            if len(seg) >= 3:
                amount = _to_float(seg[2])
        if amount is None:
            amount = _pick(37)
        if amount is None and price is not None and volume is not None:
            amount = price * volume

        change = None
        change_pct = None
        if price is not None and prev_close is not None and prev_close != 0:
            change = price - prev_close
            change_pct = (change / prev_close) * 100

        # US quotes occasionally shift fields for certain symbols; guard against obviously wrong prices.
        if (market or "").upper() == "US" and price is not None and prev_close is not None and prev_close > 0:
            try:
                ratio = price / prev_close
                if ratio < 0.2 or ratio > 5.0:
                    return None
            except Exception:
                pass

        bid = _pick(9)
        ask = _pick(11)

        market_cap = None
        if mkt == "US":
            def _normalize_us_market_cap(raw: float | None) -> float | None:
                if raw is None or raw <= 0:
                    return None
                candidates = [raw, raw * 1e6, raw * 1e8, raw * 1e9]
                valid = [c for c in candidates if 5e8 <= c <= 5e12]
                return max(valid) if valid else None

            for raw in [_pick(45), _pick(44), _pick(62), _pick(63)]:
                market_cap = _normalize_us_market_cap(raw)
                if market_cap is not None:
                    break
        elif mkt in {"CN", "HK"}:
            # Tencent quote uses market cap in "亿" for CN/HK (e.g. 18004.14 means 18004.14亿)
            cand = _pick(45) or _pick(44)
            if cand is not None and cand > 0:
                market_cap = cand * 1e8

        return StockPriceResponse(
            symbol=symbol,
            name=name or symbol,
            market=(market or "CN").upper(),
            price=price,
            change=change,
            change_pct=change_pct,
            volume=volume,
            amount=amount,
            market_cap=market_cap,
            high=high,
            low=low,
            open=open_p,
            prev_close=prev_close,
            turnover_rate=None,
            volume_ratio=None,
            amplitude=None,
            bid=bid,
            ask=ask,
        )
    except Exception:
        return None


def _tencent_fetch_pe_ratio(symbol: str, market: str) -> float | None:
    """Best-effort PE ratio from Tencent quote fields.

    This is used as a fallback when yfinance is rate-limited and AkShare spot APIs are unavailable.
    """
    try:
        q = _tencent_quote_code(symbol, market)
        if not q:
            return None

        disable_proxies_for_process()
        import httpx

        with httpx.Client(timeout=10, follow_redirects=True) as client:
            text = client.get(f"https://qt.gtimg.cn/q={q}").text

        if '"' not in text:
            return None
        payload = text.split('"', 2)[1]
        parts = payload.split("~")

        def _num(idx: int) -> float | None:
            try:
                if idx < 0 or idx >= len(parts):
                    return None
                v = parts[idx]
                if v is None:
                    return None
                sv = str(v).strip()
                if not sv:
                    return None
                fv = float(sv)
                # sanity range
                if fv <= 0 or fv >= 5000:
                    return None
                return fv
            except Exception:
                return None

        m = (market or "CN").upper()

        if m == "HK":
            return _num(39) or _num(65)
        if m == "US":
            return _num(39) or _num(41) or _num(65)
        if m == "CN":
            return _num(39) or _num(65)
        return None
    except Exception:
        return None


@app.get("/api/qwen/ping")
def qwen_ping():
    """Check whether Qwen (DashScope) is reachable with current DASHSCOPE_API_KEY."""
    try:
        from core.llm_qwen import test_qwen_connection

        ok, msg = test_qwen_connection()
        has_key = bool((os.environ.get("DASHSCOPE_API_KEY") or "").strip())
        return {"ok": bool(ok), "message": msg, "has_key": has_key}
    except Exception as e:
        has_key = bool((os.environ.get("DASHSCOPE_API_KEY") or "").strip())
        return {"ok": False, "message": f"exception:{e}", "has_key": has_key}


_AKSHARE_US_LAST_FETCH_TS = 0.0

def _akshare_us_fetch_history_df(symbol: str, count: int = 500):
    global _AKSHARE_US_LAST_FETCH_TS
    try:
        import pandas as pd
        import datetime as dt
        import time

        sym = (symbol or "").strip().upper()
        if not sym:
            return None
        base = sym.split(".", 1)[0]

        disable_proxies_for_process()
        import akshare as ak

        now_ts = time.time()
        elapsed = now_ts - _AKSHARE_US_LAST_FETCH_TS
        if elapsed < 3.0:
            time.sleep(3.0 - elapsed)

        ak_sym = f"105.{base}"
        df = ak.stock_us_hist(symbol=ak_sym, period="daily", adjust="qfq")
        _AKSHARE_US_LAST_FETCH_TS = time.time()

        if df is None or df.empty:
            return None

        out = pd.DataFrame(
            {
                "date": pd.to_datetime(df["日期"], errors="coerce"),
                "open": pd.to_numeric(df.get("开盘"), errors="coerce"),
                "high": pd.to_numeric(df.get("最高"), errors="coerce"),
                "low": pd.to_numeric(df.get("最低"), errors="coerce"),
                "close": pd.to_numeric(df.get("收盘"), errors="coerce"),
                "volume": pd.to_numeric(df.get("成交量"), errors="coerce"),
                "amount": pd.to_numeric(df.get("成交额"), errors="coerce"),
            }
        )
        out = out.dropna(subset=["date"]).sort_values("date")
        if out.empty:
            return None

        try:
            closed_date = _latest_closed_trade_date_us()
            dseries = pd.to_datetime(out["date"], errors="coerce")
            out = out[dseries.dt.date <= closed_date]
        except Exception:
            pass

        if out.empty:
            return None

        if count and len(out) > count:
            out = out.tail(count)

        return out if not out.empty else None
    except Exception:
        return None


def _eodhd_fetch_history_df(symbol: str, count: int = 500):
    try:
        import pandas as pd
        import datetime as dt

        sym = (symbol or "").strip().upper()
        if not sym:
            return None
        base = sym.split(".", 1)[0]
        sym = f"{base}.US"

        disable_proxies_for_process()
        import httpx

        url = f"https://eodhistoricaldata.com/api/eod/{sym}"
        params = {
            "api_token": "69f096c44e05b2.71478497",
            "fmt": "json",
            "from": (dt.date.today() - dt.timedelta(days=800)).isoformat(),
            "to": dt.date.today().isoformat(),
        }
        with httpx.Client(timeout=20, follow_redirects=True) as client:
            resp = client.get(url, params=params)
            if resp.status_code != 200:
                return None
            rows = resp.json()

        if not rows or not isinstance(rows, list):
            return None

        if count and len(rows) > count:
            rows = rows[-count:]

        out = pd.DataFrame(
            {
                "date": pd.to_datetime([r.get("date") for r in rows], errors="coerce"),
                "open": pd.to_numeric([r.get("open") for r in rows], errors="coerce"),
                "high": pd.to_numeric([r.get("high") for r in rows], errors="coerce"),
                "low": pd.to_numeric([r.get("low") for r in rows], errors="coerce"),
                "close": pd.to_numeric([r.get("close") for r in rows], errors="coerce"),
                "volume": pd.to_numeric([r.get("volume") for r in rows], errors="coerce"),
            }
        )
        out = out.dropna(subset=["date"]).sort_values("date")
        if out.empty:
            return None

        try:
            closed_date = _latest_closed_trade_date_us()
            dseries = pd.to_datetime(out["date"], errors="coerce")
            out = out[dseries.dt.date <= closed_date]
        except Exception:
            pass

        if out.empty:
            return None

        out["amount"] = out["close"] * out["volume"]
        return out if not out.empty else None
    except Exception:
        return None


def _stooq_fetch_history_df(symbol: str, count: int = 800):
    try:
        import csv
        import pandas as pd
        import datetime as dt

        sym = (symbol or "").strip().lower()
        if not sym:
            return None
        sym = sym.split(".", 1)[0]
        if not sym.endswith(".us"):
            sym = f"{sym}.us"

        disable_proxies_for_process()
        import httpx

        url = f"https://stooq.com/q/d/l/?s={sym}&i=d"
        with httpx.Client(timeout=15, follow_redirects=True) as client:
            resp = client.get(url)
            resp.raise_for_status()
            text = resp.text

        reader = csv.DictReader(text.splitlines())
        rows = [r for r in reader if r.get("Close") and r.get("Close") != "-"]
        if not rows:
            return None

        if count and len(rows) > count:
            rows = rows[-count:]

        def _num(v):
            if v in (None, "", "-"):
                return None
            try:
                return float(v)
            except Exception:
                return None

        out = pd.DataFrame(
            {
                "date": pd.to_datetime([r.get("Date") for r in rows], errors="coerce"),
                "open": pd.to_numeric([_num(r.get("Open")) for r in rows], errors="coerce"),
                "high": pd.to_numeric([_num(r.get("High")) for r in rows], errors="coerce"),
                "low": pd.to_numeric([_num(r.get("Low")) for r in rows], errors="coerce"),
                "close": pd.to_numeric([_num(r.get("Close")) for r in rows], errors="coerce"),
                "volume": pd.to_numeric([_num(r.get("Volume")) for r in rows], errors="coerce"),
            }
        )
        out = out.dropna(subset=["date"]).sort_values("date")
        if out.empty:
            return None

        # US daily indicators should use latest fully closed trading day only.
        try:
            closed_date = _latest_closed_trade_date_us()
            dseries = pd.to_datetime(out["date"], errors="coerce")
            out = out[dseries.dt.date <= closed_date]
        except Exception:
            pass

        if out.empty:
            return None

        out["amount"] = out["close"] * out["volume"]

        try:
            min_date = (dt.date.today() - dt.timedelta(days=420)).isoformat()
            out = out[out["date"] >= pd.to_datetime(min_date)]
        except Exception:
            pass
        return out if not out.empty else None
    except Exception:
        return None


def _tencent_fetch_history_df(symbol: str, market: str, count: int = 420):
    try:
        import pandas as pd

        q = _tencent_quote_code(symbol, market)
        if not q:
            return None

        disable_proxies_for_process()
        import httpx

        url = f"https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param={q},day,,,{count},qfq"
        with httpx.Client(timeout=6, follow_redirects=True) as client:
            resp = client.get(url)
            resp.raise_for_status()
            data = resp.json()

        qdata = ((data or {}).get("data") or {}).get(q) or {}
        kdata = qdata.get("day") or qdata.get("qfqday")
        if not kdata:
            return None

        out = pd.DataFrame(
            {
                "date": pd.to_datetime([r[0] for r in kdata], errors="coerce"),
                "open": pd.to_numeric([r[1] for r in kdata], errors="coerce"),
                "close": pd.to_numeric([r[2] for r in kdata], errors="coerce"),
                "high": pd.to_numeric([r[3] for r in kdata], errors="coerce"),
                "low": pd.to_numeric([r[4] for r in kdata], errors="coerce"),
                "volume": pd.to_numeric([r[5] for r in kdata], errors="coerce"),
            }
        )
        out = out.dropna(subset=["date"]).sort_values("date")
        if (market or "").upper() == "CN":
            out["volume"] = pd.to_numeric(out["volume"], errors="coerce") * 100
        out["amount"] = out["close"] * out["volume"]
        return out
    except Exception:
        return None


@app.get("/api/stock/search", response_model=list[StockSearchResult])
def search_stocks(q: str, market: str = "ALL"):
    """Search for stocks by keyword across CN/HK/US markets.
    market=ALL searches all 3 markets; market=CN/HK/US searches a single market.
    Always supplements with Tencent smartbox for best coverage.
    """
    try:
        import concurrent.futures

        def _tencent_smartbox(query: str) -> list[StockSearchResult]:
            try:
                import httpx
                from urllib.parse import quote_plus

                disable_proxies_for_process()
                url = f"https://smartbox.gtimg.cn/s3/?q={quote_plus(query)}&t=all"
                with httpx.Client(timeout=4, follow_redirects=True) as client:
                    text = client.get(url).text

                if '"' not in text:
                    return []
                payload = text.split('"', 2)[1]
                items = [x for x in payload.split('^') if x]
                out: list[StockSearchResult] = []

                def _decode_name(s: str) -> str:
                    try:
                        if "\\\\u" in s or "\\\\U" in s:
                            s = s.replace("\\\\u", "\\u").replace("\\\\U", "\\U")
                        if "\\u" in s or "\\U" in s:
                            return s.encode("utf-8").decode("unicode_escape")
                    except Exception:
                        pass
                    return s

                for it in items:
                    parts = it.split('~')
                    if len(parts) < 3:
                        continue
                    m = (parts[0] or '').lower()
                    code = (parts[1] or '').strip()
                    name = _decode_name((parts[2] or '').strip() or code)

                    if m in {"hk"}:
                        if code.isdigit():
                            sym = f"{code.zfill(5)}.HK"
                            out.append(StockSearchResult(symbol=sym, name=name, market="HK"))
                    elif m in {"sh", "sz", "bj"}:
                        if code.isdigit() and len(code) == 6:
                            suf = "SH" if m == "sh" else "SZ" if m == "sz" else "BJ"
                            sym = f"{code}.{suf}"
                            out.append(StockSearchResult(symbol=sym, name=name, market="CN"))
                    elif m in {"us"}:
                        base = code.split('.', 1)[0].upper()
                        if base:
                            out.append(StockSearchResult(symbol=base, name=name, market="US"))
                    if len(out) >= 15:
                        break
                return out
            except Exception:
                return []

        def _search_single_market(mkt: str, query_lower: str) -> list[StockSearchResult]:
            """Search a single market's spot data with fuzzy matching."""
            try:
                df = _get_stock_spot_data(mkt)
                if df is None or df.empty:
                    return []
                code_col = "代码" if "代码" in df.columns else df.columns[0]
                name_col = "名称" if "名称" in df.columns else (df.columns[1] if len(df.columns) > 1 else None)
                # Fast pre-filter to avoid scanning full dataframe row-by-row.
                code_series = df[code_col].astype(str).str.lower()
                if name_col:
                    name_series = df[name_col].astype(str).str.lower()
                    mask = code_series.str.contains(query_lower, regex=False, na=False) | name_series.str.contains(query_lower, regex=False, na=False)
                else:
                    mask = code_series.str.contains(query_lower, regex=False, na=False)

                filtered = df[mask].head(50)
                hits: list[StockSearchResult] = []
                for _, row in filtered.iterrows():
                    code = str(row.get(code_col, ""))
                    name = str(row.get(name_col, "")) if name_col else ""
                    name_lower = name.lower()
                    code_lower = code.lower()
                    # Direct substring match
                    matched = query_lower in code_lower or query_lower in name_lower
                    # Reverse match: stock name contains query (handles "美团" matching "美团-W")
                    if not matched and len(query_lower) >= 2:
                        matched = any(ch in name_lower for ch in [query_lower]) or name_lower.startswith(query_lower)
                    if matched:
                        if mkt == "CN":
                            if code.startswith("6"):
                                sym = f"{code}.SH"
                            elif code.startswith(("0", "3")):
                                sym = f"{code}.SZ"
                            else:
                                sym = f"{code}.BJ"
                        elif mkt == "HK":
                            sym = f"{code.zfill(5)}.HK"
                        else:
                            sym = code
                        hits.append(StockSearchResult(symbol=sym, name=name, market=mkt))
                        if len(hits) >= 5:
                            break
                return hits
            except Exception:
                return []

        import re as _re

        q_stripped = q.strip()
        q_lower = q_stripped.lower()
        m_upper = (market or "ALL").strip().upper()

        # --- Smart query preprocessing ---
        # 1) Detect "hk3690", "HK03690", "us.AAPL", "sh600519", "sz002594" patterns
        _prefix_market_map = {
            "hk": "HK", "港": "HK", "港股": "HK",
            "us": "US", "美": "US", "美股": "US",
            "sh": "CN", "sz": "CN", "bj": "CN", "cn": "CN", "a股": "CN", "沪": "CN", "深": "CN",
        }
        _prefix_match = _re.match(r'^(hk|us|sh|sz|bj|cn|港股?|美股?|a股|沪|深)[.\-_]?(\d{1,6}|[a-zA-Z]{1,10})$', q_lower)
        if _prefix_match:
            _pfx = _prefix_match.group(1)
            _code = _prefix_match.group(2)
            _detected_mkt = _prefix_market_map.get(_pfx, None)
            if _detected_mkt:
                m_upper = _detected_mkt
                q_stripped = _code.upper() if _detected_mkt == "US" else _code
                q_lower = q_stripped.lower()

        # 2) Strip trailing market suffixes from Chinese name queries: "美团香港" -> "美团", "苹果美股" -> "苹果"
        _suffix_strip_re = _re.sub(r'(香港|美股|港股|A股|a股|沪股|深股|美国|中国)$', '', q_stripped)
        extra_queries = []
        if _suffix_strip_re and _suffix_strip_re != q_stripped:
            extra_queries.append(_suffix_strip_re.lower())

        # Determine which markets to search
        markets_to_search = ["CN", "HK", "US"] if m_upper == "ALL" else [m_upper]

        # Fast path: smartbox is usually enough and much lighter than loading full spot tables.
        # If smartbox already has results, return immediately to avoid expensive scans
        # that can impact responsiveness of other endpoints (e.g. indicators loading in UI).
        quick_results: list[StockSearchResult] = []
        quick_results.extend(_tencent_smartbox(q_stripped))
        for eq in extra_queries:
            quick_results.extend(_tencent_smartbox(eq))
        if quick_results:
            seen_quick = set()
            deduped_quick: list[StockSearchResult] = []
            for r in quick_results:
                key = (r.symbol.upper(), r.market.upper())
                if key not in seen_quick:
                    seen_quick.add(key)
                    deduped_quick.append(r)
            return deduped_quick[:15]

        # Search spot data + Tencent smartbox in parallel
        all_results: list[StockSearchResult] = []
        pool = concurrent.futures.ThreadPoolExecutor(max_workers=6)
        try:
            futures = {}
            for mkt in markets_to_search:
                futures[pool.submit(_search_single_market, mkt, q_lower)] = f"spot_{mkt}"
                # Also search with stripped query if different
                for eq in extra_queries:
                    futures[pool.submit(_search_single_market, mkt, eq)] = f"spot_{mkt}_alt"
            futures[pool.submit(_tencent_smartbox, q_stripped)] = "smartbox"
            # Also smartbox the stripped query
            for eq in extra_queries:
                futures[pool.submit(_tencent_smartbox, eq)] = "smartbox_alt"

            done, not_done = concurrent.futures.wait(
                list(futures.keys()),
                timeout=5,
                return_when=concurrent.futures.ALL_COMPLETED,
            )
            for fut in done:
                try:
                    all_results.extend(fut.result())
                except Exception:
                    pass

            # Critical: never block request waiting for straggler tasks.
            for fut in not_done:
                fut.cancel()
        finally:
            pool.shutdown(wait=False, cancel_futures=True)

        # Deduplicate by (symbol, market)
        seen = set()
        deduped: list[StockSearchResult] = []
        for r in all_results:
            key = (r.symbol.upper(), r.market.upper())
            if key not in seen:
                seen.add(key)
                deduped.append(r)

        if deduped:
            return deduped[:15]

        # Last fallback to mock data
        mock_stocks = [
            {"symbol": "600519.SH", "name": "贵州茅台", "market": "CN"},
            {"symbol": "00700.HK", "name": "腾讯控股", "market": "HK"},
            {"symbol": "AAPL", "name": "苹果公司", "market": "US"},
            {"symbol": "BABA", "name": "阿里巴巴", "market": "US"},
            {"symbol": "601318.SH", "name": "中国平安", "market": "CN"},
            {"symbol": "000858.SZ", "name": "五粮液", "market": "CN"},
            {"symbol": "MCD", "name": "麦当劳", "market": "US"},
            {"symbol": "03690.HK", "name": "美团-W", "market": "HK"},
        ]
        return [
            StockSearchResult(symbol=s["symbol"], name=s["name"], market=s["market"])
            for s in mock_stocks
            if q_lower in s["symbol"].lower() or q_lower in s["name"].lower()
        ][:15]
    except Exception as e:
        print(f"Search error: {e}")
        return []


class StockPriceResponse(BaseModel):
    symbol: str
    name: str
    market: str
    price: Optional[float]
    change: Optional[float]
    change_pct: Optional[float]
    volume: Optional[float]
    market_cap: Optional[float]
    high: Optional[float] = None
    low: Optional[float] = None
    amount: Optional[float] = None
    open: Optional[float] = None
    prev_close: Optional[float] = None
    turnover_rate: Optional[float] = None
    volume_ratio: Optional[float] = None
    amplitude: Optional[float] = None
    bid: Optional[float] = None
    ask: Optional[float] = None


class StockIndicatorsResponse(BaseModel):
    symbol: str
    name: Optional[str] = None
    market: str
    currency: Optional[str] = None
    as_of: Optional[str] = None

    market_cap: Optional[float] = None
    amount: Optional[float] = None
    high_52w: Optional[float] = None
    low_52w: Optional[float] = None

    ma5: Optional[float] = None
    ma20: Optional[float] = None
    ma60: Optional[float] = None
    slope_raw: Optional[float] = None
    slope_pct: Optional[float] = None
    trend: Optional[str] = None
    slope_advice: Optional[str] = None
    pe_ratio: Optional[float] = None
    atr14: Optional[float] = None
    rsi14: Optional[float] = None
    rsi_rebound: Optional[bool] = None
    macd_dif: Optional[float] = None
    macd_dea: Optional[float] = None
    macd_hist: Optional[float] = None

    buy_price_aggressive: Optional[float] = None
    buy_price_stable: Optional[float] = None
    sell_price: Optional[float] = None

    buy_condition_desc: Optional[str] = None
    sell_condition_desc: Optional[str] = None

    buy_reason: Optional[str] = None
    sell_reason: Optional[str] = None

    buy_price_aggressive_ok: Optional[bool] = None
    buy_price_stable_ok: Optional[bool] = None
    sell_price_ok: Optional[bool] = None

    signal_golden_cross: Optional[bool] = None
    signal_death_cross: Optional[bool] = None
    signal_macd_bullish: Optional[bool] = None
    signal_rsi_overbought: Optional[bool] = None
    signal_vol_gt_ma5: Optional[bool] = None
    signal_vol_gt_ma10: Optional[bool] = None

    kdj_k: Optional[float] = None
    kdj_d: Optional[float] = None
    kdj_j: Optional[float] = None
    boll_upper: Optional[float] = None
    boll_mid: Optional[float] = None
    boll_lower: Optional[float] = None
    boll_pct_b: Optional[float] = None

    buy_score: Optional[int] = None
    buy_grade: Optional[str] = None
    sell_score: Optional[int] = None
    sell_grade: Optional[str] = None
    buy_score_details: Optional[dict] = None
    sell_score_details: Optional[dict] = None
    data_points: Optional[int] = None
    data_quality: Optional[str] = None


# Price cache: (market, symbol) -> (timestamp, StockPriceResponse)
_PRICE_CACHE: dict[tuple[str, str], tuple[float, object]] = {}
_PRICE_CACHE_TTL = 300  # seconds (5 min) - price changes slowly enough


@app.get("/api/stock/price", response_model=Optional[StockPriceResponse])
def get_stock_price(symbol: str, market: str = "CN"):
    """Get real-time stock price."""
    try:
        market = (market or "CN").upper()
        _price_key = (market, (symbol or "").strip().upper())
        _price_cached = _PRICE_CACHE.get(_price_key)
        if _price_cached and (time.time() - _price_cached[0]) < _PRICE_CACHE_TTL:
            return _price_cached[1]

        def _yfinance_market_cap_us(sym: str):
            try:
                disable_proxies_for_process()
                import yfinance as yf

                t = yf.Ticker(sym)
                info_fast = getattr(t, "fast_info", None) or {}
                cand = info_fast.get("market_cap") or info_fast.get("marketCap")
                if cand is None:
                    try:
                        cand = (t.info or {}).get("marketCap")
                    except Exception:
                        cand = None
                if cand is None:
                    return None
                mc = float(cand)
                if mc <= 0:
                    return None
                return mc
            except Exception:
                return None

        def _yfinance_quote_us(sym: str) -> Optional[StockPriceResponse]:
            try:
                disable_proxies_for_process()
                import yfinance as yf

                t = yf.Ticker(sym)
                fast = getattr(t, "fast_info", None) or {}
                info = {}
                try:
                    info = t.info or {}
                except Exception:
                    info = {}

                price = _safe_float(
                    fast.get("last_price")
                    or fast.get("lastPrice")
                    or fast.get("regularMarketPrice")
                    or info.get("regularMarketPrice")
                )
                prev_close = _safe_float(
                    fast.get("previous_close")
                    or fast.get("previousClose")
                    or info.get("previousClose")
                )
                open_p = _safe_float(fast.get("open") or info.get("open"))
                high = _safe_float(fast.get("day_high") or fast.get("dayHigh") or info.get("dayHigh"))
                low = _safe_float(fast.get("day_low") or fast.get("dayLow") or info.get("dayLow"))
                volume = _safe_float(fast.get("last_volume") or fast.get("lastVolume") or info.get("volume"))
                amount = (price * volume) if (price is not None and volume is not None) else None

                if price is None:
                    return None

                change = None
                change_pct = None
                if prev_close is not None and prev_close != 0:
                    change = price - prev_close
                    change_pct = (change / prev_close) * 100

                name = (info.get("shortName") or info.get("longName") or sym) if isinstance(info, dict) else sym
                mc = _yfinance_market_cap_us(sym)

                return StockPriceResponse(
                    symbol=sym,
                    name=str(name) if name is not None else sym,
                    market="US",
                    price=price,
                    change=change,
                    change_pct=change_pct,
                    volume=volume,
                    market_cap=mc,
                    high=high,
                    low=low,
                    amount=amount,
                    open=open_p,
                    prev_close=prev_close,
                    turnover_rate=None,
                    volume_ratio=None,
                    amplitude=None,
                    bid=None,
                    ask=None,
                )
            except Exception:
                return None

        tq_quote = None
        if market == "US":
            tq_quote = _tencent_fetch_quote(symbol, market)

            # For US, prefer Tencent quote for OHLC/volume/amount fields (AkShare US spot often has mismatched units/columns).
            if tq_quote is not None and tq_quote.price is not None:
                mc = _yfinance_market_cap_us(symbol)
                if mc is not None and mc > 0:
                    tq_quote.market_cap = mc
                _PRICE_CACHE[_price_key] = (time.time(), tq_quote)
                return tq_quote

            yf_q = _yfinance_quote_us(symbol)
            if yf_q is not None:
                _PRICE_CACHE[_price_key] = (time.time(), yf_q)
                return yf_q

        # For CN/HK markets: prioritize fast Tencent single-stock query
        # Skip slow akshare full-market data (_get_stock_spot_data) entirely
        if market in ("CN", "HK"):
            tq_quote = _tencent_fetch_quote(symbol, market)
            if tq_quote is not None and tq_quote.price is not None:
                _PRICE_CACHE[_price_key] = (time.time(), tq_quote)
                return tq_quote
            # Fallback: return None instead of blocking on slow akshare
            return None

        df = _get_stock_spot_data(market)
        if df is None or df.empty:
            base = tq_quote or _tencent_fetch_quote(symbol, market)
            if base is None:
                return None
            if market == "US":
                mc = _yfinance_market_cap_us(symbol)
                if mc is not None and mc > 0:
                    base.market_cap = mc
            _PRICE_CACHE[_price_key] = (time.time(), base)
            return base
        
        # Extract code from symbol
        if market == "CN":
            code = symbol.split(".")[0]
        elif market == "HK":
            code = symbol.replace(".HK", "").zfill(5)
        else:
            code = symbol
        
        code_upper = str(code).upper()
        candidate_code_cols = [
            c
            for c in [
                "代码",
                "symbol",
                "Symbol",
                "股票代码",
                "ticker",
                "Ticker",
            ]
            if c in df.columns
        ]
        if not candidate_code_cols:
            candidate_code_cols = [df.columns[0]]

        row_df = None
        for ccol in candidate_code_cols:
            tmp = df[df[ccol].astype(str).str.upper() == code_upper]
            if not tmp.empty:
                row_df = tmp
                break
        if row_df is None or row_df.empty:
            # Fallback: contains match
            for ccol in candidate_code_cols:
                tmp = df[df[ccol].astype(str).str.upper().str.contains(code_upper, na=False)]
                if not tmp.empty:
                    row_df = tmp
                    break
        if row_df is None or row_df.empty:
            base = tq_quote or _tencent_fetch_quote(symbol, market)
            if base is None:
                return None
            if market == "US":
                mc = _yfinance_market_cap_us(symbol)
                if mc is not None and mc > 0:
                    base.market_cap = mc
            _PRICE_CACHE[_price_key] = (time.time(), base)
            return base

        row = row_df.iloc[0]
        
        def _to_float(v):
            if v is None:
                return None
            if isinstance(v, str) and not v.strip():
                return None
            try:
                return float(v)
            except Exception:
                return None

        def _pick_float(keys: list[str]):
            for k in keys:
                if k in df.columns and row.get(k) is not None and row.get(k) != "":
                    val = _to_float(row.get(k))
                    if val is not None:
                        return val
            return None

        # Extract data based on column names
        name = str(row.get("名称") or row.get("name") or row.get("Name") or "")
        price = _pick_float(["最新价", "现价", "收盘", "price", "Price", "last"])
        change = _pick_float(["涨跌额", "涨跌", "change", "Change"])
        change_pct = _pick_float(["涨跌幅", "涨跌幅%", "涨跌幅(%)", "pct", "pct_chg", "change_pct", "ChangePct"])
        volume = _pick_float(["成交量", "成交量(手)", "成交量(股)", "volume", "Volume"])
        amount = _pick_float(["成交额", "成交额(元)", "成交金额", "成交金额(元)", "amount", "Amount"])
        market_cap = _pick_float(["总市值", "市值", "总市值(元)", "market_cap", "MarketCap"])
        open_p = _pick_float(["今开", "开盘", "开盘价", "open", "Open"])
        prev_close = _pick_float(["昨收", "前收盘", "昨收盘", "prev_close", "PrevClose"])
        turnover_rate = _pick_float(["换手率", "换手率(%)", "turnover", "turnover_rate", "TurnoverRate"])
        volume_ratio = _pick_float(["量比", "量比(%)", "volume_ratio", "VolumeRatio"])
        amplitude = _pick_float(["振幅", "振幅(%)", "amplitude", "Amplitude"])
        bid = _pick_float(["买一", "买一价", "买入", "bid", "Bid"])
        ask = _pick_float(["卖一", "卖一价", "卖出", "ask", "Ask"])

        high = None
        low = None
        if "最高" in df.columns and row.get("最高") is not None and row.get("最高") != "":
            try:
                high = float(row.get("最高"))
            except Exception:
                high = None
        if "最低" in df.columns and row.get("最低") is not None and row.get("最低") != "":
            try:
                low = float(row.get("最低"))
            except Exception:
                low = None
        if high is None:
            high = _pick_float(["最高", "high", "High"])
        if low is None:
            low = _pick_float(["最低", "low", "Low"])
        if market == "US":
            amount = None
        elif market == "CN":
            if volume is not None:
                volume = volume * 100

        if market == "US":
            mc = _yfinance_market_cap_us(symbol)
            if mc is not None and mc > 0:
                market_cap = mc
        
        _result = StockPriceResponse(
            symbol=symbol,
            name=name,
            market=market,
            price=price,
            change=change,
            change_pct=change_pct,
            volume=volume,
            amount=amount,
            market_cap=market_cap,
            high=high,
            low=low,
            open=open_p,
            prev_close=prev_close,
            turnover_rate=turnover_rate,
            volume_ratio=volume_ratio,
            amplitude=amplitude,
            bid=bid,
            ask=ask,
        )
        _PRICE_CACHE[_price_key] = (time.time(), _result)
        return _result
    except Exception as e:
        print(f"Price error: {e}")
        return None


_INDICATOR_CACHE: dict[tuple[str, str], tuple[float, dict]] = {}

# Cache history data to reduce external calls (especially yfinance rate limits)
_HISTORY_CACHE: dict[tuple[str, str], tuple[float, "pd.DataFrame"]] = {}

# PE ratio changes slowly — cache for 4 hours to avoid repeated slow fetches
_PE_CACHE: dict[tuple[str, str], tuple[float, object]] = {}

# yfinance t.info is slow (1-3s); cache it separately so PE + name/market_cap share one call
_YF_INFO_CACHE: dict[str, tuple[float, dict]] = {}


def _fetch_yf_info(yf_symbol: str, timeout_s: float = 4.0) -> dict:
    """Fetch yfinance Ticker.info with caching (1h TTL). Returns {} on failure."""
    import time as _time
    now = _time.time()
    cached = _YF_INFO_CACHE.get(yf_symbol)
    if cached and (now - cached[0]) < 3600:
        return cached[1]
    try:
        disable_proxies_for_process()
        import yfinance as yf
        import concurrent.futures as _cf
        def _do_fetch():
            t = yf.Ticker(yf_symbol)
            try:
                return t.info or {}
            except Exception:
                return {}
        with _cf.ThreadPoolExecutor(max_workers=1) as _ex:
            fut = _ex.submit(_do_fetch)
            try:
                info = fut.result(timeout=timeout_s)
            except Exception:
                info = {}
        _YF_INFO_CACHE[yf_symbol] = (now, info)
        return info
    except Exception:
        return {}


def _rsi14(series):
    import pandas as pd

    s = pd.to_numeric(series, errors="coerce").astype(float)
    delta = s.diff()
    gain = delta.clip(lower=0)
    loss = (-delta).clip(lower=0)

    period = 14
    # Wilder RSI: first average is SMA over first `period` values, then recursive smoothing.
    avg_gain = gain.rolling(window=period, min_periods=period).mean()
    avg_loss = loss.rolling(window=period, min_periods=period).mean()

    for i in range(period + 1, len(s)):
        if pd.isna(avg_gain.iat[i]) and not pd.isna(avg_gain.iat[i - 1]):
            avg_gain.iat[i] = avg_gain.iat[i - 1]
        if pd.isna(avg_loss.iat[i]) and not pd.isna(avg_loss.iat[i - 1]):
            avg_loss.iat[i] = avg_loss.iat[i - 1]
        if not pd.isna(avg_gain.iat[i - 1]):
            avg_gain.iat[i] = (avg_gain.iat[i - 1] * (period - 1) + gain.iat[i]) / period
        if not pd.isna(avg_loss.iat[i - 1]):
            avg_loss.iat[i] = (avg_loss.iat[i - 1] * (period - 1) + loss.iat[i]) / period

    rs = avg_gain / avg_loss
    rsi = 100 - (100 / (1 + rs))
    return rsi


def _macd(series):
    s = series.astype(float)
    ema12 = s.ewm(span=12, adjust=False).mean()
    ema26 = s.ewm(span=26, adjust=False).mean()
    dif = ema12 - ema26
    dea = dif.ewm(span=9, adjust=False).mean()
    hist = (dif - dea) * 2
    return dif, dea, hist


def _find_cross(ma_fast, ma_slow, lookback: int = 20):
    import pandas as pd

    if ma_fast is None or ma_slow is None:
        return None, None
    s = (ma_fast - ma_slow).dropna()
    if s.empty:
        return None, None
    s = s.tail(lookback + 1)
    prev = s.shift(1)
    cross_up = (prev <= 0) & (s > 0)
    cross_down = (prev >= 0) & (s < 0)
    idx_up = s[cross_up].index
    idx_down = s[cross_down].index
    last_up = idx_up[-1] if len(idx_up) else None
    last_down = idx_down[-1] if len(idx_down) else None
    return last_up, last_down


def _atr14(df, period: int = 14):
    import pandas as pd

    close = pd.to_numeric(df.get("close"), errors="coerce")
    high = pd.to_numeric(df.get("high"), errors="coerce")
    low = pd.to_numeric(df.get("low"), errors="coerce")

    # Some data sources may not provide high/low reliably; fall back to close.
    try:
        if high is None or high.isna().all():
            high = close
        else:
            high = high.fillna(close)
        if low is None or low.isna().all():
            low = close
        else:
            low = low.fillna(close)
    except Exception:
        pass
    prev_close = close.shift(1)
    tr1 = high - low
    tr2 = (high - prev_close).abs()
    tr3 = (low - prev_close).abs()
    tr = pd.concat([tr1, tr2, tr3], axis=1).max(axis=1)

    # Wilder ATR: first ATR is SMA(period), then recursive smoothing.
    if tr is None or tr.empty:
        return tr

    atr = pd.Series(index=tr.index, dtype="float64")
    valid_tr = pd.to_numeric(tr, errors="coerce")

    if len(valid_tr.dropna()) < period:
        # Short series fallback: keep a usable ATR curve.
        return valid_tr.rolling(window=period, min_periods=1).mean()

    seed = valid_tr.rolling(window=period, min_periods=period).mean()
    try:
        first_idx = seed.first_valid_index()
        if first_idx is None:
            return valid_tr.rolling(window=period, min_periods=1).mean()
        atr.loc[first_idx] = float(seed.loc[first_idx])
        started = False
        prev_atr = None
        for idx, trv in valid_tr.items():
            if idx == first_idx:
                started = True
                prev_atr = atr.loc[idx]
                continue
            if not started:
                continue
            if pd.isna(trv):
                atr.loc[idx] = prev_atr
                continue
            prev_atr = ((float(prev_atr) * (period - 1)) + float(trv)) / float(period)
            atr.loc[idx] = prev_atr
    except Exception:
        return valid_tr.rolling(window=period, min_periods=1).mean()

    return atr




def _kdj(df, n=9, m1=3, m2=3):
    import pandas as pd
    low_n = pd.to_numeric(df.get("low"), errors="coerce").rolling(window=n).min()
    high_n = pd.to_numeric(df.get("high"), errors="coerce").rolling(window=n).max()
    close_s = pd.to_numeric(df.get("close"), errors="coerce")
    denom = high_n - low_n
    denom = denom.replace(0, float("nan"))
    rsv = (close_s - low_n) / denom * 100
    k = rsv.ewm(com=m1 - 1, adjust=False).mean()
    d = k.ewm(com=m2 - 1, adjust=False).mean()
    j = 3 * k - 2 * d
    return k, d, j


def _bollinger(series, window=20, num_std=2):
    import pandas as pd
    s = pd.to_numeric(series, errors="coerce")
    mid = s.rolling(window=window).mean()
    std = s.rolling(window=window).std()
    upper = mid + num_std * std
    lower = mid - num_std * std
    denom = upper - lower
    denom = denom.replace(0, float("nan"))
    pct_b = (s - lower) / denom
    return upper, mid, lower, pct_b


def _calc_slope_pct_linear(series, window=20):
    import numpy as np
    import pandas as pd
    s = series.dropna().tail(window)
    if len(s) < 10:
        return 0.0
    y = s.values.astype(float)
    x = np.arange(len(y), dtype=float)
    n = len(y)
    denom = n * np.sum(x**2) - np.sum(x)**2
    if abs(denom) < 1e-12:
        return 0.0
    slope = (n * np.sum(x * y) - np.sum(x) * np.sum(y)) / denom
    mean_val = np.mean(y)
    if abs(mean_val) < 1e-9:
        return 0.0
    return (slope / mean_val) * 100

def _build_buy_condition_desc(
    *,
    buy_score: int | None = None,
    buy_grade: str | None = None,
    buy_score_details: dict | None = None,
    **_kwargs,
) -> str | None:
    try:
        if buy_grade is None:
            return None
        parts = []
        for k, v in sorted(buy_score_details.items(), key=lambda x: x[1]["score"], reverse=True):
            if v["score"] > 0:
                parts.append(f"{v['reason']}({v['score']}/{v['max']}分)")
        if parts:
            return f"综合评分{buy_score}分-{buy_grade}：" + "；".join(parts)
        return f"综合评分{buy_score}分-{buy_grade}：暂无明显买入信号"
    except Exception:
        return None


def _build_sell_condition_desc(
    *,
    sell_score: int | None = None,
    sell_grade: str | None = None,
    sell_score_details: dict | None = None,
    **_kwargs,
) -> str | None:
    try:
        if sell_grade is None:
            return None
        parts = []
        for k, v in sorted(sell_score_details.items(), key=lambda x: x[1]["score"], reverse=True):
            if v["score"] > 0:
                parts.append(f"{v['reason']}({v['score']}/{v['max']}分)")
        if parts:
            return f"综合评分{sell_score}分-{sell_grade}：" + "；".join(parts)
        return f"综合评分{sell_score}分-{sell_grade}：暂无明显卖出信号"
    except Exception:
        return None


def _safe_float(v):
    try:
        if v is None:
            return None
        if isinstance(v, str) and not v.strip():
            return None
        fv = float(v)
        return fv
    except Exception:
        return None


def _fetch_history_df(symbol: str, market: str):
    import pandas as pd
    import datetime as dt

    global _YF_US_COOLDOWN_UNTIL

    key = ((market or "CN").upper(), (symbol or "").upper())
    now = dt.datetime.utcnow().timestamp()
    ttl_seconds = float((os.environ.get("HISTORY_CACHE_TTL_SECONDS") or "14400").strip() or "14400")
    cached = _HISTORY_CACHE.get(key)
    if cached and (now - float(cached[0])) < ttl_seconds:
        try:
            df0 = cached[1]
            if df0 is not None and not df0.empty:
                return df0.copy()
        except Exception:
            pass

    m = (market or "CN").upper()
    end = dt.date.today()
    start = end - dt.timedelta(days=800)

    if m == "CN":
        # Critical stability path: Tencent history is much more stable/fast in production.
        # We intentionally avoid AkShare by default because intermittent hangs there can
        # block indicators UI for a long time. AkShare fallback can be enabled explicitly.
        tdf = _tencent_fetch_history_df(symbol, market)
        if tdf is not None and not tdf.empty:
            _HISTORY_CACHE[key] = (now, tdf)
            return tdf

        if (os.environ.get("ENABLE_AKSHARE_CN_HISTORY_FALLBACK") or "").strip() == "1":
            try:
                disable_proxies_for_process()
                import akshare as ak

                code = symbol.split(".")[0]
                df = ak.stock_zh_a_hist(
                    symbol=code,
                    period="daily",
                    start_date=start.strftime("%Y%m%d"),
                    end_date=end.strftime("%Y%m%d"),
                    adjust="",
                )
                if df is not None and not df.empty:
                    out = pd.DataFrame(
                        {
                            "date": pd.to_datetime(df["日期"], errors="coerce"),
                            "open": pd.to_numeric(df.get("开盘"), errors="coerce"),
                            "high": pd.to_numeric(df.get("最高"), errors="coerce"),
                            "low": pd.to_numeric(df.get("最低"), errors="coerce"),
                            "close": pd.to_numeric(df.get("收盘"), errors="coerce"),
                            "volume": pd.to_numeric(df.get("成交量"), errors="coerce") * 100,
                            "amount": pd.to_numeric(df.get("成交额"), errors="coerce"),
                        }
                    )
                    out = out.dropna(subset=["date"]).sort_values("date")
                    if out is not None and not out.empty:
                        _HISTORY_CACHE[key] = (now, out)
                        return out
            except Exception:
                pass
        return None

    try:
        disable_proxies_for_process()
        import yfinance as yf

        yf_symbol = symbol
        if m == "HK":
            if not yf_symbol.upper().endswith(".HK"):
                base = yf_symbol.replace(".HK", "")
                yf_symbol = f"{base.zfill(4)}.HK" if base.isdigit() else f"{base}.HK"

        def _is_yf_rate_limited(err_text: str) -> bool:
            s = (err_text or "").lower()
            return "ratelimit" in s or "too many requests" in s or "rate limited" in s

        raw = None
        now_ts = float(now)
        in_cooldown = False
        if m == "US":
            try:
                in_cooldown = float(_YF_US_COOLDOWN_UNTIL or 0.0) > now_ts
            except Exception:
                in_cooldown = False

        if not in_cooldown:
            try:
                raw = yf.download(
                    yf_symbol,
                    start=start.isoformat(),
                    end=(end + dt.timedelta(days=1)).isoformat(),
                    progress=False,
                    threads=False,
                )
            except Exception as e:
                if m == "US" and _is_yf_rate_limited(str(e)):
                    try:
                        _YF_US_COOLDOWN_UNTIL = now_ts + 60.0
                    except Exception:
                        pass
                raw = None

        # yfinance sometimes returns empty on rate limit without raising
        if m == "US" and (raw is None or getattr(raw, "empty", True)):
            try:
                _YF_US_COOLDOWN_UNTIL = max(float(_YF_US_COOLDOWN_UNTIL or 0.0), now_ts + 60.0)
            except Exception:
                pass

        # Fallback: yfinance download sometimes fails but Ticker.history can work.
        # For US, if we are rate-limited, skip this fallback and go straight to Stooq.
        if raw is None or raw.empty:
            try:
                if m == "US" and float(_YF_US_COOLDOWN_UNTIL or 0.0) > now_ts:
                    raw = None
                else:
                    t = yf.Ticker(yf_symbol)
                    raw = t.history(period="2y", interval="1d")
            except Exception:
                raw = None

        if raw is None or raw.empty:
            if m == "US":
                adf = _akshare_us_fetch_history_df(symbol)
                if adf is not None and not adf.empty:
                    _HISTORY_CACHE[key] = (now, adf)
                    return adf
                edf = _eodhd_fetch_history_df(symbol)
                if edf is not None and not edf.empty:
                    _HISTORY_CACHE[key] = (now, edf)
                    return edf
                sdf = _stooq_fetch_history_df(symbol)
                if sdf is not None and not sdf.empty:
                    _HISTORY_CACHE[key] = (now, sdf)
                    return sdf

            tdf = _tencent_fetch_history_df(symbol, market)
            if tdf is not None and not tdf.empty:
                _HISTORY_CACHE[key] = (now, tdf)
                return tdf
            return None

        raw = raw.reset_index()
        date_col = "Date" if "Date" in raw.columns else ("index" if "index" in raw.columns else raw.columns[0])
        out = pd.DataFrame(
            {
                "date": pd.to_datetime(raw[date_col], errors="coerce"),
                "open": pd.to_numeric(raw.get("Open"), errors="coerce"),
                "high": pd.to_numeric(raw.get("High"), errors="coerce"),
                "low": pd.to_numeric(raw.get("Low"), errors="coerce"),
                "close": pd.to_numeric(raw.get("Close"), errors="coerce"),
                "volume": pd.to_numeric(raw.get("Volume"), errors="coerce"),
            }
        )
        out = out.dropna(subset=["date"]).sort_values("date")

        # US daily indicators should use latest fully closed trading day only.
        if m == "US":
            try:
                closed_date = _latest_closed_trade_date_us()
                dseries = pd.to_datetime(out["date"], errors="coerce")
                # yfinance can return timezone-aware timestamps for some calls.
                if hasattr(dseries.dt, "tz") and dseries.dt.tz is not None:
                    dseries = dseries.dt.tz_convert("America/New_York")
                out = out[dseries.dt.date <= closed_date]
            except Exception:
                pass

        out["amount"] = out["close"] * out["volume"]

        def _looks_valid_history(df: "pd.DataFrame") -> bool:
            try:
                if df is None or df.empty:
                    return False
                if len(df) < 120:
                    return False
                c = pd.to_numeric(df.get("close"), errors="coerce").dropna()
                if len(c) < 120:
                    return False
                uniq = int(c.tail(120).nunique(dropna=True))
                if uniq <= 5:
                    return False
                std = float(c.tail(120).std()) if len(c) >= 2 else 0.0
                if std <= 1e-9:
                    return False
                return True
            except Exception:
                return False

        # US: Never use Tencent kline fallback (often returns only 2 bars). Prefer AkShare -> EODHD -> Stooq if yfinance data looks wrong.
        if m == "US" and not _looks_valid_history(out):
            adf = _akshare_us_fetch_history_df(symbol)
            if adf is not None and not adf.empty and _looks_valid_history(adf):
                _HISTORY_CACHE[key] = (now, adf)
                return adf
            edf = _eodhd_fetch_history_df(symbol)
            if edf is not None and not edf.empty and _looks_valid_history(edf):
                _HISTORY_CACHE[key] = (now, edf)
                return edf
            sdf = _stooq_fetch_history_df(symbol)
            if sdf is not None and not sdf.empty and _looks_valid_history(sdf):
                _HISTORY_CACHE[key] = (now, sdf)
                return sdf
            return None

        if out is not None and not out.empty:
            _HISTORY_CACHE[key] = (now, out)
        return out
    except Exception:
        if m == "US":
            adf = _akshare_us_fetch_history_df(symbol)
            if adf is not None and not adf.empty:
                _HISTORY_CACHE[key] = (now, adf)
                return adf
            edf = _eodhd_fetch_history_df(symbol)
            if edf is not None and not edf.empty:
                _HISTORY_CACHE[key] = (now, edf)
                return edf
            sdf = _stooq_fetch_history_df(symbol)
            if sdf is not None and not sdf.empty:
                _HISTORY_CACHE[key] = (now, sdf)
                return sdf
            return None

        tdf = _tencent_fetch_history_df(symbol, market)
        if tdf is not None and not tdf.empty:
            _HISTORY_CACHE[key] = (now, tdf)
            return tdf
        return None


class StockAnnouncementItem(BaseModel):
    title: str
    date: Optional[str] = None
    url: Optional[str] = None


@app.get("/api/stock/announcements", response_model=list[StockAnnouncementItem])
def get_stock_announcements(symbol: str, market: str = "CN", limit: int = 5):
    """Get latest stock announcements/news."""
    market = (market or "CN").upper()
    results: list[StockAnnouncementItem] = []
    try:
        disable_proxies_for_process()
        if market == "CN":
            import akshare as ak
            code = symbol.split(".")[0]
            try:
                df = ak.stock_news_em(symbol=code)
                if df is not None and not df.empty:
                    for _, row in df.head(limit).iterrows():
                        title = str(row.get("新闻标题", "")).strip()
                        date_val = str(row.get("发布时间", "")).strip()
                        url_val = row.get("新闻链接", None)
                        if title:
                            results.append(StockAnnouncementItem(
                                title=title,
                                date=date_val[:10] if date_val else None,
                                url=str(url_val).strip() if url_val else None,
                            ))
            except Exception:
                pass
        elif market in ("US", "HK"):
            import yfinance as yf
            yf_symbol = symbol
            if market == "HK" and not yf_symbol.upper().endswith(".HK"):
                base = yf_symbol.replace(".HK", "")
                yf_symbol = f"{base.zfill(4)}.HK" if base.isdigit() else f"{base}.HK"
            try:
                t = yf.Ticker(yf_symbol)
                news = t.news or []
                for item in news[:limit]:
                    title = item.get("title", "")
                    pub = item.get("providerPublishTime")
                    date_str = None
                    if pub:
                        from datetime import datetime, timezone
                        try:
                            date_str = datetime.fromtimestamp(pub, tz=timezone.utc).strftime("%Y-%m-%d")
                        except Exception:
                            pass
                    link = item.get("link", None)
                    if title:
                        results.append(StockAnnouncementItem(
                            title=title.strip(),
                            date=date_str,
                            url=link,
                        ))
            except Exception:
                pass
    except Exception:
        pass
    return results


@app.get("/api/stock/indicators", response_model=Optional[StockIndicatorsResponse])
def get_stock_indicators(symbol: str, market: str = "CN"):
    import time
    import pandas as pd

    key = (market or "CN").upper(), (symbol or "").upper()
    now = time.time()
    cached = _INDICATOR_CACHE.get(key)
    if cached and (now - cached[0]) < 3600:
        return cached[1]

    df = _fetch_history_df(symbol, market)
    if df is None or df.empty:
        return None

    # Clean history to avoid NaN tails causing null indicators
    try:
        df = df.dropna(subset=["date", "close"])
        df = df.sort_values("date")
        df = df.drop_duplicates(subset=["date"], keep="last")
    except Exception:
        pass
    if df is None or df.empty:
        return None

    close = pd.to_numeric(df.get("close"), errors="coerce")
    high = pd.to_numeric(df.get("high"), errors="coerce")
    low = pd.to_numeric(df.get("low"), errors="coerce")
    vol = pd.to_numeric(df.get("volume"), errors="coerce")

    close = close.dropna()
    if close.empty:
        return None

    ma5 = close.rolling(window=5, min_periods=1).mean()
    ma20 = close.rolling(window=20, min_periods=1).mean()
    ma60 = close.rolling(window=60, min_periods=1).mean()
    rsi = _rsi14(close)
    dif, dea, hist = _macd(close)
    kdj_k, kdj_d, kdj_j = _kdj(df)
    boll_upper, boll_mid, boll_lower, boll_pct_b = _bollinger(close)

    slope_raw_s = ma60.rolling(window=len(ma60), min_periods=1).apply(
        lambda x: _calc_slope_pct_linear(pd.Series(x)), raw=False
    )
    slope_pct_s = slope_raw_s

    tail252 = df.tail(252)
    high_52w = float(pd.to_numeric(tail252["high"], errors="coerce").max()) if not tail252.empty else None
    low_52w = float(pd.to_numeric(tail252["low"], errors="coerce").min()) if not tail252.empty else None

    last_row = df.iloc[-1]
    as_of = None
    try:
        as_of = pd.to_datetime(last_row["date"]).date().isoformat()
    except Exception:
        as_of = None

    amount = None
    try:
        amount = float(last_row.get("amount")) if last_row.get("amount") is not None else None
    except Exception:
        amount = None

    # signals
    last_up, last_down = _find_cross(ma5, ma20, lookback=30)
    signal_golden_cross = bool(last_up is not None and (last_down is None or last_up > last_down))
    signal_death_cross = bool(last_down is not None and (last_up is None or last_down > last_up))

    macd_dif = float(dif.iloc[-1]) if not dif.empty and pd.notna(dif.iloc[-1]) else None
    macd_dea = float(dea.iloc[-1]) if not dea.empty and pd.notna(dea.iloc[-1]) else None
    macd_hist = float(hist.iloc[-1]) if not hist.empty and pd.notna(hist.iloc[-1]) else None
    macd_hist_prev = None
    try:
        macd_hist_prev = float(hist.iloc[-2]) if len(hist) >= 2 and pd.notna(hist.iloc[-2]) else None
    except Exception:
        macd_hist_prev = None
    signal_macd_bullish = None
    try:
        macd_ok = False
        if macd_dif is not None and macd_dea is not None and float(macd_dif) > float(macd_dea):
            macd_ok = True
        if macd_hist_prev is not None and macd_hist is not None:
            if float(macd_hist_prev) < 0 <= float(macd_hist):
                macd_ok = True
        signal_macd_bullish = bool(macd_ok)
    except Exception:
        signal_macd_bullish = None

    rsi14 = float(rsi.iloc[-1]) if not rsi.empty and pd.notna(rsi.iloc[-1]) else None
    signal_rsi_overbought = True if (rsi14 is not None and rsi14 > 70) else False if rsi14 is not None else None

    rsi_rebound = None
    rsi_today_v = None
    rsi_yesterday_v = None
    rsi_before_yesterday_v = None
    try:
        if len(rsi) >= 3:
            rsi_today = rsi.iloc[-1]
            rsi_yesterday = rsi.iloc[-2]
            rsi_before_yesterday = rsi.iloc[-3]
            if pd.notna(rsi_today) and pd.notna(rsi_yesterday) and pd.notna(rsi_before_yesterday):
                try:
                    rsi_today_v = float(rsi_today)
                    rsi_yesterday_v = float(rsi_yesterday)
                    rsi_before_yesterday_v = float(rsi_before_yesterday)
                except Exception:
                    rsi_today_v = None
                    rsi_yesterday_v = None
                    rsi_before_yesterday_v = None
                is_hook_up = bool(float(rsi_yesterday) < float(rsi_before_yesterday) and float(rsi_today) > float(rsi_yesterday))
                rsi_y_val = float(rsi_yesterday)
                if rsi_y_val < 30:
                    is_low_position = True
                elif rsi_y_val < 45:
                    is_low_position = True
                elif rsi_y_val < 55 and float(rsi_before_yesterday) - rsi_y_val > 5:
                    is_low_position = True
                else:
                    is_low_position = False
                rsi_rebound = bool(is_hook_up and is_low_position)
    except Exception:
        rsi_rebound = None
        rsi_today_v = None
        rsi_yesterday_v = None
        rsi_before_yesterday_v = None

    vol_ma5 = vol.rolling(window=5).mean()
    vol_ma10 = vol.rolling(window=10).mean()
    signal_vol_gt_ma5 = None
    signal_vol_gt_ma10 = None
    if len(vol) >= 6 and pd.notna(vol.iloc[-1]) and pd.notna(vol_ma5.iloc[-2]):
        signal_vol_gt_ma5 = float(vol.iloc[-1]) > float(vol_ma5.iloc[-2])
    if len(vol) >= 11 and pd.notna(vol.iloc[-1]) and pd.notna(vol_ma10.iloc[-2]):
        signal_vol_gt_ma10 = float(vol.iloc[-1]) > float(vol_ma10.iloc[-2])

    last_close = float(close.iloc[-1]) if pd.notna(close.iloc[-1]) else None
    # Fallback: if last_close is None but we have MA values, use the most recent valid close
    if last_close is None and not close.empty:
        # Try to find the last valid close price
        valid_closes = close.dropna()
        if not valid_closes.empty:
            last_close = float(valid_closes.iloc[-1])
    last_open = float(df["open"].astype(float).iloc[-1]) if "open" in df.columns and pd.notna(df["open"].astype(float).iloc[-1]) else None
    last_low = float(low.iloc[-1]) if pd.notna(low.iloc[-1]) else None
    ma5_now = float(ma5.iloc[-1]) if pd.notna(ma5.iloc[-1]) else None
    ma20_now = float(ma20.iloc[-1]) if pd.notna(ma20.iloc[-1]) else None
    ma5_prev = float(ma5.iloc[-2]) if len(ma5) >= 2 and pd.notna(ma5.iloc[-2]) else None
    ma20_prev = float(ma20.iloc[-2]) if len(ma20) >= 2 and pd.notna(ma20.iloc[-2]) else None

    price_up = None
    try:
        if len(close) >= 2 and pd.notna(close.iloc[-2]) and last_close is not None:
            price_up = bool(last_close > float(close.iloc[-2]))
    except Exception:
        price_up = None

    vol_ok = None
    try:
        if (signal_vol_gt_ma5 is not None or signal_vol_gt_ma10 is not None) and (price_up is not None):
            vol_ok = bool(price_up is True and (signal_vol_gt_ma5 or signal_vol_gt_ma10))
        else:
            vol_ok = None
    except Exception:
        vol_ok = None

    ma20_up = None
    try:
        if ma20_now is not None and ma20_prev is not None:
            ma20_up = bool(ma20_now > ma20_prev)
    except Exception:
        ma20_up = None

    slope_raw = None
    slope_pct = None
    trend = None
    slope_advice = None
    try:
        sraw_valid = slope_raw_s.dropna()
        spct_valid = slope_pct_s.dropna()
        slope_raw = float(sraw_valid.iloc[-1]) if not sraw_valid.empty else None
        slope_pct = float(spct_valid.iloc[-1]) if not spct_valid.empty else None

        # If history is too short, slope_* at last point may be NaN; degrade to 0.
        if slope_raw is None or slope_pct is None:
            slope_raw = 0.0
            slope_pct = 0.0

        # 趋势：斜率大于 0 = 上涨；约等于 0 = 观望；小于 0 = 下跌
        eps = 0.02
        if slope_pct is None:
            trend = None
        elif abs(slope_pct) <= eps:
            trend = "观望"
        elif slope_pct > 0:
            trend = "上涨"
        else:
            trend = "下跌"

        # Slope 率建议：
        # - Slope% ≈ 0%：不要买
        # - 0% ~ 0.1%：小心买
        # - 0.2% ~ 0.3%：放心买
        # - 0.4%+：有危险
        if slope_pct is None:
            slope_advice = None
        elif abs(slope_pct) <= eps:
            slope_advice = "横盘"
        elif slope_pct < 0:
            slope_advice = "下跌"
        elif 0 < slope_pct < 0.05:
            slope_advice = "缓慢上涨"
        elif slope_pct < 0.2:
            slope_advice = "上涨"
        else:
            slope_advice = "急涨"
    except Exception:
        slope_raw = None
        slope_pct = None
        trend = None
        slope_advice = None

    atr14_s = None
    atr14 = None
    try:
        atr14_s = _atr14(df, period=14)
        if atr14_s is not None and not atr14_s.empty:
            av = atr14_s.dropna()
            atr14 = float(av.iloc[-1]) if not av.empty else None
        if atr14 is None:
            atr14 = 0.0
    except Exception:
        atr14 = None

    m = (market or "CN").upper()

    def _find_pe_column(cols: list[str]) -> str | None:
        try:
            for c in cols:
                if not isinstance(c, str):
                    continue
                if "市盈率" in c and "TTM" in c.upper():
                    return c
            for c in cols:
                if not isinstance(c, str):
                    continue
                if "市盈率" in c:
                    return c
            for c in cols:
                if not isinstance(c, str):
                    continue
                cl = c.lower()
                if "pe" == cl or "pe_ttm" in cl or "pettm" in cl or "pe(ttm" in cl or "pe (ttm" in cl:
                    return c
                if "pe" in cl and "ratio" in cl:
                    return c
            for c in cols:
                if not isinstance(c, str):
                    continue
                if "PE" in c:
                    return c
        except Exception:
            return None
        return None

    def _yf_sym_for_market(sym: str, mkt: str) -> str:
        if mkt == "HK" and not sym.upper().endswith(".HK"):
            base = sym.replace(".HK", "")
            return f"{base.zfill(4)}.HK" if base.isdigit() else f"{base}.HK"
        return sym

    # --- Parallel fetch: PE + name/market_cap ---
    # Both are slow network calls; run them concurrently to cut wall-clock time.
    import concurrent.futures as _cf
    import time as _time

    pe_cache_key = (m, (symbol or "").upper())
    pe_now = _time.time()
    _pe_cached = _PE_CACHE.get(pe_cache_key)
    pe_ratio = None
    name = None
    market_cap = None
    currency = "CNY" if m == "CN" else ("HKD" if m == "HK" else "USD")

    def _fetch_pe_ratio_task() -> object:
        """Fetch PE ratio; returns float or None."""
        try:
            if m in {"US", "HK"}:
                yf_sym = _yf_sym_for_market(symbol, m)
                info = _fetch_yf_info(yf_sym, timeout_s=4.0)
                fast = {}
                try:
                    disable_proxies_for_process()
                    import yfinance as yf
                    t = yf.Ticker(yf_sym)
                    fast = getattr(t, "fast_info", None) or {}
                except Exception:
                    pass
                pe = _safe_float(
                    fast.get("trailing_pe")
                    or fast.get("trailingPE")
                    or info.get("trailingPE")
                    or info.get("forwardPE")
                )
                if m == "HK":
                    try:
                        disable_proxies_for_process()
                        import akshare as ak
                        spot = ak.stock_hk_spot_em()
                        if spot is not None and not spot.empty:
                            code_col = next((c for c in ("代码", "symbol", "Symbol") if c in spot.columns), None)
                            if code_col:
                                base = (symbol or "").split(".", 1)[0].upper().replace(".HK", "")
                                base = base.zfill(5) if base.isdigit() else base
                                hit = spot[spot[code_col].astype(str).str.upper() == base]
                                if not hit.empty:
                                    pe_col = _find_pe_column([str(c) for c in list(spot.columns)])
                                    if pe_col:
                                        pe_ak = _safe_float(hit.iloc[0].get(pe_col))
                                        if pe_ak is not None:
                                            pe = pe_ak
                    except Exception:
                        pass
                if pe is None:
                    try:
                        disable_proxies_for_process()
                        import akshare as ak
                        spot = ak.stock_us_spot_em() if m == "US" else ak.stock_hk_spot_em()
                        if spot is not None and not spot.empty:
                            code_col = next((c for c in ("代码", "symbol", "Symbol") if c in spot.columns), None)
                            if code_col:
                                base = (symbol or "").split(".", 1)[0].upper()
                                if m == "HK":
                                    base = base.replace(".HK", "")
                                    base = base.zfill(5) if base.isdigit() else base
                                hit = spot[spot[code_col].astype(str).str.upper() == base]
                                if not hit.empty:
                                    pe_col = _find_pe_column([str(c) for c in list(spot.columns)])
                                    if pe_col:
                                        pe = _safe_float(hit.iloc[0].get(pe_col))
                    except Exception:
                        pass
                if pe is None:
                    try:
                        pe = _safe_float(_tencent_fetch_pe_ratio(symbol, m))
                    except Exception:
                        pass
                return pe
            elif m == "CN":
                try:
                    pe = _safe_float(_tencent_fetch_pe_ratio(symbol, m))
                except Exception:
                    pe = None
                if pe is None and (os.environ.get("ENABLE_AKSHARE_CN_PE_FALLBACK") or "").strip() == "1":
                    try:
                        disable_proxies_for_process()
                        import akshare as ak
                        code = symbol.split(".")[0]
                        pe_df = ak.stock_a_indicator_lg(symbol=code)
                        if pe_df is not None and not pe_df.empty:
                            last = pe_df.iloc[-1]
                            cols = [str(c) for c in list(pe_df.columns)]
                            ttm_cols = [c for c in cols if ("ttm" in c.lower()) or ("市盈率" in c and "ttm" in c.upper())]
                            prefer = list(ttm_cols) + ["pe_ttm", "市盈率TTM", "市盈率(动)", "市盈率", "pe"]
                            for k in prefer:
                                if k in pe_df.columns:
                                    pe = _safe_float(last.get(k))
                                    if pe is not None:
                                        break
                    except Exception:
                        pass
                if pe is None:
                    try:
                        pe = _safe_float(_tencent_fetch_pe_ratio(symbol, m))
                    except Exception:
                        pass
                return pe
        except Exception:
            return None

    def _fetch_name_cap_task() -> tuple:
        """Fetch (name, market_cap, currency) for HK/US; returns (None, None, default_currency) for CN."""
        cur = "CNY" if m == "CN" else ("HKD" if m == "HK" else "USD")
        nm = None
        cap = None
        if m in {"US", "HK"}:
            try:
                yf_sym = _yf_sym_for_market(symbol, m)
                info = _fetch_yf_info(yf_sym, timeout_s=4.0)
                nm = info.get("shortName") or info.get("longName")
                cap = _safe_float(info.get("marketCap"))
                cur = info.get("currency") or cur
            except Exception:
                pass
            if cap is None and m == "HK":
                try:
                    tq = _tencent_fetch_quote(symbol, m)
                    if tq is not None:
                        if nm is None and tq.name:
                            nm = tq.name
                        if tq.market_cap is not None:
                            cap = tq.market_cap
                except Exception:
                    pass
        return nm, cap, cur

    if _pe_cached and (pe_now - _pe_cached[0]) < 14400:
        pe_ratio = _pe_cached[1]
        # Still need name/market_cap
        try:
            with _cf.ThreadPoolExecutor(max_workers=1) as _ex:
                _nc_fut = _ex.submit(_fetch_name_cap_task)
                try:
                    name, market_cap, currency = _nc_fut.result(timeout=5)
                except Exception:
                    name, market_cap, currency = None, None, currency
        except Exception:
            pass
    else:
        # Run PE + name/market_cap in parallel
        try:
            with _cf.ThreadPoolExecutor(max_workers=2) as _ex:
                _pe_fut = _ex.submit(_fetch_pe_ratio_task)
                _nc_fut = _ex.submit(_fetch_name_cap_task)
                try:
                    pe_ratio = _pe_fut.result(timeout=6)
                except Exception:
                    pe_ratio = None
                try:
                    name, market_cap, currency = _nc_fut.result(timeout=6)
                except Exception:
                    name, market_cap, currency = None, None, currency
        except Exception:
            pass
        _PE_CACHE[pe_cache_key] = (pe_now, pe_ratio)

    data_points = len(df)
    data_quality = "full" if data_points >= 120 else "partial" if data_points >= 60 else "insufficient"
    aggressive_ok = None
    stable_ok = None
    buy_score = 0
    buy_score_details = {}
    sell_score = 0
    sell_score_details = {}
    buy_grade = None
    sell_grade = None
    prev_max_close = None
    prev_max_rsi = None
    sell_price = None
    sell_reason = None
    try:
        ma60_now = float(ma60.iloc[-1]) if ma60 is not None and pd.notna(ma60.iloc[-1]) else None
        kdj_k_now = float(kdj_k.iloc[-1]) if kdj_k is not None and not kdj_k.empty and pd.notna(kdj_k.iloc[-1]) else None
        kdj_d_now = float(kdj_d.iloc[-1]) if kdj_d is not None and not kdj_d.empty and pd.notna(kdj_d.iloc[-1]) else None
        kdj_j_now = float(kdj_j.iloc[-1]) if kdj_j is not None and not kdj_j.empty and pd.notna(kdj_j.iloc[-1]) else None
        boll_pct_b_now = float(boll_pct_b.iloc[-1]) if boll_pct_b is not None and not boll_pct_b.empty and pd.notna(boll_pct_b.iloc[-1]) else None
        kdj_k_prev = float(kdj_k.iloc[-2]) if kdj_k is not None and len(kdj_k) >= 2 and pd.notna(kdj_k.iloc[-2]) else None
        kdj_d_prev = float(kdj_d.iloc[-2]) if kdj_d is not None and len(kdj_d) >= 2 and pd.notna(kdj_d.iloc[-2]) else None
        kdj_golden_cross = False
        kdj_death_cross = False
        if kdj_k_now is not None and kdj_d_now is not None and kdj_k_prev is not None and kdj_d_prev is not None:
            kdj_golden_cross = bool(kdj_k_prev <= kdj_d_prev and kdj_k_now > kdj_d_now)
            kdj_death_cross = bool(kdj_k_prev >= kdj_d_prev and kdj_k_now < kdj_d_now)
        # === BUY SCORING (optimized by backtest edge analysis) ===
        # Edge rankings: RSI<30(+0.022) > boll<0.1(+0.005) > ma_full(+0.003) > kdj_j<20(+0.003)
        #   > vol>ma10(+0.003) > macd_bull(+0.003) > slope>0(+0.002)
        # Negative: price_near_ma20(-0.020) macd_cross_up(-0.008) rsi<50(-0.003)
        if slope_pct is not None and slope_pct > 0.05:
            buy_score_details["trend"] = {"score": 8, "max": 8, "reason": "上涨趋势"}
        elif slope_pct is not None and slope_pct > 0:
            buy_score_details["trend"] = {"score": 5, "max": 8, "reason": "缓慢上行"}
        else:
            buy_score_details["trend"] = {"score": 0, "max": 8, "reason": "下行趋势"}
        if ma5_now and ma20_now and ma60_now and last_close:
            if ma5_now > ma20_now > ma60_now:
                buy_score_details["ma_align"] = {"score": 8, "max": 8, "reason": "多头排列"}
            elif ma20_now > ma60_now:
                buy_score_details["ma_align"] = {"score": 3, "max": 8, "reason": "部分多头"}
            else:
                buy_score_details["ma_align"] = {"score": 0, "max": 8, "reason": "非多头"}
        else:
            buy_score_details["ma_align"] = {"score": 0, "max": 8, "reason": "数据不足"}
        if last_close and ma60_now:
            above60 = float(last_close) > float(ma60_now)
            if above60:
                buy_score_details["price_pos"] = {"score": 5, "max": 5, "reason": "高于MA60"}
            else:
                buy_score_details["price_pos"] = {"score": 0, "max": 5, "reason": "低于MA60"}
        else:
            buy_score_details["price_pos"] = {"score": 0, "max": 5, "reason": "数据不足"}
        if rsi14 is not None:
            if rsi14 < 30:
                rsi_sc = 25
                if rsi_rebound:
                    rsi_sc = 25
                rsi_reason = f"RSI极度超卖({rsi14:.1f})"
            elif rsi14 < 40:
                rsi_sc = 20
                if rsi_rebound:
                    rsi_sc = 22
                    rsi_reason = f"RSI超卖反弹({rsi14:.1f})"
                else:
                    rsi_reason = f"RSI超卖({rsi14:.1f})"
            elif rsi14 < 50 and rsi_rebound:
                rsi_sc = 15
                rsi_reason = f"RSI低位拐头({rsi14:.1f})"
            elif rsi_rebound:
                rsi_sc = 8
                rsi_reason = f"RSI反弹({rsi14:.1f})"
            elif rsi14 < 50:
                rsi_sc = 5
                rsi_reason = f"RSI偏低({rsi14:.1f})"
            elif rsi14 <= 60:
                rsi_sc = 3
                rsi_reason = f"RSI中性({rsi14:.1f})"
            else:
                rsi_sc = 0
                rsi_reason = f"RSI偏高({rsi14:.1f})"
            buy_score_details["rsi"] = {"score": rsi_sc, "max": 25, "reason": rsi_reason}
        else:
            buy_score_details["rsi"] = {"score": 0, "max": 25, "reason": "无RSI"}
        if kdj_j_now is not None:
            if kdj_j_now < 20:
                kdj_sc = 15
                if kdj_golden_cross:
                    kdj_sc = 15
                kdj_reason = f"KDJ超卖(J={kdj_j_now:.1f})"
            elif kdj_golden_cross and kdj_j_now < 30:
                kdj_sc = 10
                kdj_reason = f"KDJ金叉超卖(J={kdj_j_now:.1f})"
            elif kdj_golden_cross:
                kdj_sc = 5
                kdj_reason = f"KDJ金叉(J={kdj_j_now:.1f})"
            elif kdj_k_now is not None and kdj_d_now is not None and kdj_k_now > kdj_d_now:
                kdj_sc = 6
                kdj_reason = f"KDJ多头(J={kdj_j_now:.1f})"
            else:
                kdj_sc = 0
                kdj_reason = f"KDJ(J={kdj_j_now:.1f})"
            buy_score_details["kdj"] = {"score": kdj_sc, "max": 15, "reason": kdj_reason}
        else:
            buy_score_details["kdj"] = {"score": 0, "max": 15, "reason": "无KDJ"}
        if signal_vol_gt_ma10:
            buy_score_details["volume"] = {"score": 10, "max": 10, "reason": "放量>MA10"}
        elif signal_vol_gt_ma5:
            buy_score_details["volume"] = {"score": 7, "max": 10, "reason": "放量>MA5"}
        else:
            buy_score_details["volume"] = {"score": 0, "max": 10, "reason": "缩量"}
        if signal_macd_bullish:
            buy_score_details["macd"] = {"score": 5, "max": 5, "reason": "MACD多头"}
        elif macd_hist is not None and macd_hist_prev is not None and macd_hist > macd_hist_prev:
            buy_score_details["macd"] = {"score": 3, "max": 5, "reason": "MACD柱收窄"}
        else:
            buy_score_details["macd"] = {"score": 0, "max": 5, "reason": "MACD偏空"}
        if boll_pct_b_now is not None:
            if boll_pct_b_now < 0.05:
                buy_score_details["boll"] = {"score": 12, "max": 12, "reason": "深度跌破布林下轨"}
            elif boll_pct_b_now < 0.1:
                buy_score_details["boll"] = {"score": 10, "max": 12, "reason": "触及布林下轨"}
            elif boll_pct_b_now < 0.2:
                buy_score_details["boll"] = {"score": 6, "max": 12, "reason": "布林下方"}
            else:
                buy_score_details["boll"] = {"score": 0, "max": 12, "reason": f"布林%B={boll_pct_b_now:.2f}"}
        else:
            buy_score_details["boll"] = {"score": 0, "max": 12, "reason": "无布林"}
        buy_score = sum(v["score"] for v in buy_score_details.values())
        buy_total_max = 88
        buy_pct = buy_score / buy_total_max if buy_total_max else 0
        if buy_pct >= 0.75:
            buy_grade = "强烈买入"
        elif buy_pct >= 0.55:
            buy_grade = "建议买入"
        elif buy_pct >= 0.35:
            buy_grade = "观望"
        else:
            buy_grade = "不建议"
        aggressive_ok = buy_pct >= 0.60
        # === SELL SCORING (optimized by backtest) ===
        # Key insight: RSI>70 edge=+0.018 (trend continues!), macd_cross_dn edge=+0.009
        # Sell signals should focus on trend REVERSAL, not overbought
        if rsi14 is not None and rsi14 > 75:
            sell_score_details["rsi_ob"] = {"score": 15, "max": 15, "reason": f"RSI严重超买({rsi14:.1f})"}
        elif rsi14 is not None and rsi14 > 70:
            sell_score_details["rsi_ob"] = {"score": 5, "max": 15, "reason": f"RSI超买({rsi14:.1f})"}
        else:
            sell_score_details["rsi_ob"] = {"score": 0, "max": 15, "reason": "RSI正常"}
        if macd_hist_prev is not None and macd_hist is not None and macd_hist_prev > 0 > macd_hist:
            sell_score_details["macd_death"] = {"score": 18, "max": 18, "reason": "MACD柱翻绿"}
        elif macd_dif is not None and macd_dea is not None and macd_dif < macd_dea:
            sell_score_details["macd_death"] = {"score": 8, "max": 18, "reason": "MACD空头"}
        else:
            sell_score_details["macd_death"] = {"score": 0, "max": 18, "reason": "MACD未死叉"}
        if last_close is not None and ma20_now is not None:
            if float(last_close) < float(ma20_now) * 0.97:
                sell_score_details["break_ma20"] = {"score": 12, "max": 12, "reason": "跌破MA20超3%"}
            elif float(last_close) < float(ma20_now):
                sell_score_details["break_ma20"] = {"score": 5, "max": 12, "reason": "略低于MA20"}
            else:
                sell_score_details["break_ma20"] = {"score": 0, "max": 12, "reason": "高于MA20"}
        else:
            sell_score_details["break_ma20"] = {"score": 0, "max": 12, "reason": "数据不足"}
        if kdj_j_now is not None:
            if kdj_death_cross and kdj_j_now > 80:
                sell_score_details["kdj_sell"] = {"score": 12, "max": 12, "reason": f"KDJ超买死叉(J={kdj_j_now:.1f})"}
            elif kdj_death_cross:
                sell_score_details["kdj_sell"] = {"score": 6, "max": 12, "reason": f"KDJ死叉(J={kdj_j_now:.1f})"}
            elif kdj_j_now > 95:
                sell_score_details["kdj_sell"] = {"score": 8, "max": 12, "reason": f"KDJ极度超买(J={kdj_j_now:.1f})"}
            else:
                sell_score_details["kdj_sell"] = {"score": 0, "max": 12, "reason": f"KDJ(J={kdj_j_now:.1f})"}
        else:
            sell_score_details["kdj_sell"] = {"score": 0, "max": 12, "reason": "无KDJ"}
        if boll_pct_b_now is not None:
            if boll_pct_b_now > 1.0:
                sell_score_details["boll_sell"] = {"score": 8, "max": 8, "reason": "突破布林上轨"}
            elif boll_pct_b_now > 0.85:
                sell_score_details["boll_sell"] = {"score": 3, "max": 8, "reason": "接近布林上轨"}
            else:
                sell_score_details["boll_sell"] = {"score": 0, "max": 8, "reason": f"布林%B={boll_pct_b_now:.2f}"}
        else:
            sell_score_details["boll_sell"] = {"score": 0, "max": 8, "reason": "无布林"}
        rsi_divergence = False
        if rsi14 is not None and float(rsi14) > 50:
            try:
                win = min(20, len(close) - 1)
                if win >= 10:
                    prev_close_win = close.iloc[-(win + 1):-1]
                    prev_rsi_win = rsi.iloc[-(win + 1):-1]
                    prev_max_close = float(pd.to_numeric(prev_close_win, errors="coerce").max()) if not prev_close_win.empty else None
                    prev_max_rsi = float(pd.to_numeric(prev_rsi_win, errors="coerce").max()) if not prev_rsi_win.empty else None
                    if prev_max_close and prev_max_rsi and last_close:
                        rsi_divergence = float(last_close) > prev_max_close and float(rsi14) < prev_max_rsi
            except Exception:
                pass
        if rsi_divergence:
            sell_score_details["divergence"] = {"score": 10, "max": 10, "reason": "RSI顶背离"}
        else:
            sell_score_details["divergence"] = {"score": 0, "max": 10, "reason": "无背离"}
        stop_line = None
        if atr14 is not None and last_close is not None:
            atr_stop = float(last_close) - 2 * float(atr14)
            pct_stop = float(last_close) * 0.85
            stop_line = max(atr_stop, pct_stop)
            if last_low is not None and float(last_low) <= float(stop_line):
                sell_score_details["stop_loss"] = {"score": 10, "max": 10, "reason": f"触发止损({stop_line:.2f})"}
            else:
                sell_score_details["stop_loss"] = {"score": 0, "max": 10, "reason": f"止损线={stop_line:.2f}"}
        else:
            sell_score_details["stop_loss"] = {"score": 0, "max": 10, "reason": "无ATR"}
        sell_score = sum(v["score"] for v in sell_score_details.values())
        sell_total_max = 85
        sell_pct = sell_score / sell_total_max if sell_total_max else 0
        if sell_pct >= 0.65:
            sell_grade = "强烈卖出"
        elif sell_pct >= 0.40:
            sell_grade = "建议减仓"
        else:
            sell_grade = "继续持有"
        if stop_line is not None:
            sell_price = float(stop_line)
        elif ma20_now is not None:
            sell_price = float(ma20_now)
        else:
            sell_price = float(last_close) if last_close is not None else None
        if sell_grade and sell_score > 0:
            top_rs = sorted(sell_score_details.items(), key=lambda x: x[1]["score"], reverse=True)[:4]
            sell_reason = f"{sell_grade}({sell_score}分)：" + "；".join(v["reason"] for _, v in top_rs if v["score"] > 0)
        else:
            sell_reason = "继续持有"
    except Exception:
        aggressive_ok = None
    buy_reason = None
    try:
        if buy_grade:
            top_buy = sorted(buy_score_details.items(), key=lambda x: x[1]["score"], reverse=True)[:3]
            buy_reason = f"{buy_grade}({buy_score}分)：" + "；".join(v["reason"] for _, v in top_buy if v["score"] > 0)
        else:
            buy_reason = "条件未满足"
    except Exception:
        buy_reason = None

    # 买入价位：输出为“参考买入价位”，默认用 MA20（更贴近回调买点）；若不可用则回退现价。
    # buy_price_aggressive_ok 仍表示是否满足当前策略的强条件。
    buy_price_aggressive = None
    buy_price_stable = None
    try:
        rsi_v = rsi14
        boll_v = boll_pct_b_now
        if rsi_v is not None and rsi_v < 40 and boll_v is not None and boll_v < 0.2:
            buy_price_aggressive = float(boll_lower.iloc[-1]) if boll_lower is not None and pd.notna(boll_lower.iloc[-1]) else None
            buy_price_stable = float(ma60_now) if ma60_now is not None else None
        elif rsi_v is not None and rsi_v < 50:
            buy_price_aggressive = float(ma60_now) if ma60_now is not None else None
            buy_price_stable = float(boll_lower.iloc[-1]) if boll_lower is not None and pd.notna(boll_lower.iloc[-1]) else None
        else:
            buy_price_aggressive = float(ma20_now) if ma20_now is not None else None
            buy_price_stable = float(ma60_now) if ma60_now is not None else None
        if buy_price_aggressive is None and last_close is not None:
            buy_price_aggressive = float(last_close)
        if buy_price_stable is None and ma60_now is not None:
            buy_price_stable = float(ma60_now)
    except Exception:
        buy_price_aggressive = float(ma20_now) if ma20_now is not None else (float(last_close) if last_close is not None else None)
        buy_price_stable = float(ma60_now) if 'ma60_now' in locals() and ma60_now is not None else None

    buy_condition_desc = _build_buy_condition_desc(
        buy_score=buy_score,
        buy_grade=buy_grade,
        buy_score_details=buy_score_details,
    )

    sell_condition_desc = _build_sell_condition_desc(
        sell_score=sell_score,
        sell_grade=sell_grade,
        sell_score_details=sell_score_details,
    )

    payload = StockIndicatorsResponse(
        symbol=symbol,
        name=name,
        market=market,
        currency=currency,
        as_of=as_of,
        market_cap=market_cap,
        amount=amount,
        high_52w=high_52w,
        low_52w=low_52w,
        ma5=float(ma5.iloc[-1]) if pd.notna(ma5.iloc[-1]) else None,
        ma20=float(ma20.iloc[-1]) if pd.notna(ma20.iloc[-1]) else None,
        ma60=float(ma60.iloc[-1]) if pd.notna(ma60.iloc[-1]) else None,
        slope_raw=slope_raw,
        slope_pct=slope_pct,
        trend=trend,
        slope_advice=slope_advice,
        pe_ratio=pe_ratio,
        atr14=atr14,
        rsi14=rsi14,
        rsi_rebound=rsi_rebound,
        macd_dif=macd_dif,
        macd_dea=macd_dea,
        macd_hist=macd_hist,
        buy_price_aggressive=buy_price_aggressive,
        buy_price_stable=buy_price_stable,
        sell_price=sell_price,

        buy_condition_desc=buy_condition_desc,
        sell_condition_desc=sell_condition_desc,

        buy_reason=buy_reason,
        sell_reason=sell_reason,

        buy_price_aggressive_ok=aggressive_ok,
        buy_price_stable_ok=stable_ok,
         sell_price_ok=sell_score >= 50 if sell_score else None,
        signal_golden_cross=signal_golden_cross,
        signal_death_cross=signal_death_cross,
        signal_macd_bullish=signal_macd_bullish,
        signal_rsi_overbought=signal_rsi_overbought,
        signal_vol_gt_ma5=signal_vol_gt_ma5,
        signal_vol_gt_ma10=signal_vol_gt_ma10,

        kdj_k=float(kdj_k.iloc[-1]) if kdj_k is not None and not kdj_k.empty and pd.notna(kdj_k.iloc[-1]) else None,
        kdj_d=float(kdj_d.iloc[-1]) if kdj_d is not None and not kdj_d.empty and pd.notna(kdj_d.iloc[-1]) else None,
        kdj_j=float(kdj_j.iloc[-1]) if kdj_j is not None and not kdj_j.empty and pd.notna(kdj_j.iloc[-1]) else None,
        boll_upper=float(boll_upper.iloc[-1]) if boll_upper is not None and not boll_upper.empty and pd.notna(boll_upper.iloc[-1]) else None,
        boll_mid=float(boll_mid.iloc[-1]) if boll_mid is not None and not boll_mid.empty and pd.notna(boll_mid.iloc[-1]) else None,
        boll_lower=float(boll_lower.iloc[-1]) if boll_lower is not None and not boll_lower.empty and pd.notna(boll_lower.iloc[-1]) else None,
        boll_pct_b=float(boll_pct_b.iloc[-1]) if boll_pct_b is not None and not boll_pct_b.empty and pd.notna(boll_pct_b.iloc[-1]) else None,

        buy_score=buy_score,
        buy_grade=buy_grade,
        sell_score=sell_score,
        sell_grade=sell_grade,
        buy_score_details=buy_score_details,
        sell_score_details=sell_score_details,
        data_points=data_points,
        data_quality=data_quality,
    )

    out = payload.model_dump()
    _INDICATOR_CACHE[key] = (now, out)
    return out


@app.post("/api/reports/{report_id}/reanalyze")
def reanalyze_uploaded_report(report_id: str, background_tasks: BackgroundTasks):
    """Re-run PDF analysis for an uploaded report."""
    try:
        with session_scope() as s:
            r = s.get(Report, report_id)
            if not r:
                raise HTTPException(status_code=404, detail="报告不存在")
            if r.source_type not in {"file_upload", "market_fetch"}:
                raise HTTPException(status_code=400, detail="仅支持对上传文件/市场数据报告重新分析")

            r.status = "running"
            r.error_message = None
            r.updated_at = int(time.time())

            source_type = (r.source_type or "").strip()
            meta = {}
            try:
                meta = json.loads(r.source_meta or "{}")
            except Exception:
                meta = {}

        if source_type == "file_upload":
            pdf_path = (meta.get("upload_saved_path") or "").strip()
            if not pdf_path:
                raise HTTPException(status_code=400, detail="未找到上传文件路径，无法重新分析")
            threading.Thread(target=run_pdf_analysis_in_background, args=(report_id, pdf_path), daemon=True).start()
            return {"report_id": report_id, "status": "running", "message": "已开始重新分析（上传文件）"}

        threading.Thread(target=run_analysis_in_background, args=(report_id,), daemon=True).start()
        return {"report_id": report_id, "status": "running", "message": "已开始重新分析（市场数据）"}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"重新分析失败: {str(e)}")


def run_analysis_in_background(report_id: str):
    """Run analysis in background thread."""
    try:
        disable_proxies_for_process()
        ingest_and_analyze_market_fetch(report_id)
    except Exception as e:
        # Update report status to failed
        with session_scope() as s:
            r = s.get(Report, report_id)
            if r:
                r.status = "failed"
                r.error_message = str(e)


def run_pdf_analysis_in_background(report_id: str, pdf_path: str):
    """Run PDF analysis in background thread."""
    import time
    try:
        # Update status to running
        with session_scope() as s:
            r = s.get(Report, report_id)
            if r:
                r.status = "running"
                r.updated_at = int(time.time())
        
        acquired = _PDF_ANALYSIS_SEM.acquire(blocking=False)
        if not acquired:
            with session_scope() as s:
                r = s.get(Report, report_id)
                if r:
                    r.status = "pending"
                    r.error_message = "解析任务排队中"
                    r.updated_at = int(time.time())
            _PDF_ANALYSIS_SEM.acquire()

        try:
            def _run_with_hard_timeout(path: str, use_ai: bool, force_ai: bool, timeout_seconds: float):
                max_mem_mb = int((os.environ.get("PDF_ANALYSIS_MAX_MEM_MB") or "1024").strip() or "1024")
                cpu_seconds = int((os.environ.get("PDF_ANALYSIS_MAX_CPU_SECONDS") or "180").strip() or "180")

                # IMPORTANT: use 'spawn' to avoid fork-from-thread deadlocks
                ctx = multiprocessing.get_context("spawn")
                parent_conn, child_conn = ctx.Pipe(duplex=False)
                p = ctx.Process(
                    target=_pdf_extract_worker,
                    args=(child_conn, path, use_ai, force_ai, max_mem_mb, cpu_seconds),
                )
                p.start()
                try:
                    child_conn.close()
                except Exception:
                    pass
                p.join(timeout_seconds)
                if p.is_alive():
                    try:
                        p.terminate()
                    except Exception:
                        pass
                    try:
                        p.join(5)
                    except Exception:
                        pass
                    raise RuntimeError("pdf_extract_timeout")

                try:
                    if not parent_conn.poll(2.0):
                        try:
                            code = p.exitcode
                        except Exception:
                            code = None
                        raise RuntimeError(f"pdf_extract_failed exitcode={code}")
                    payload = parent_conn.recv()
                finally:
                    try:
                        parent_conn.close()
                    except Exception:
                        pass
                if not isinstance(payload, dict):
                    raise RuntimeError("pdf_extract_failed")
                if payload.get("ok") is True:
                    return payload.get("data")
                err = (payload.get("error") or "").strip()
                if not err:
                    err = "pdf_extract_failed"
                tb = (payload.get("traceback") or "").strip()
                if tb:
                    err = f"{err}; tb={tb[:800]}"
                raise RuntimeError(err)

            base_timeout = float((os.environ.get("PDF_EXTRACT_TIMEOUT_SECONDS") or "240").strip() or "240")
            ai_timeout = float((os.environ.get("PDF_AI_TIMEOUT_SECONDS") or "600").strip() or "600")
            enable_ai = (os.environ.get("ENABLE_PDF_AI") or "1").strip() != "0"
            # Default: do NOT force AI-only. AI-only sets force_ai=True which switches text extractor
            # to fast_only mode and can bypass OCR, causing scanned PDFs to extract nothing.
            force_ai_env = (os.environ.get("FORCE_PDF_AI") or "0").strip() == "1"
            has_key = bool((os.environ.get("DASHSCOPE_API_KEY") or "").strip())

            financials = None
            non_ai_err = None
            ai_err = None

            # FORCE_PDF_AI=1 means AI-only.
            if force_ai_env:
                if not enable_ai or not has_key:
                    raise RuntimeError("ai_required_no_api_key")
                financials = _run_with_hard_timeout(
                    pdf_path,
                    use_ai=True,
                    force_ai=True,
                    timeout_seconds=ai_timeout,
                )
            else:
                # Try non-AI first. If it fails, allow AI to rescue.
                try:
                    financials = _run_with_hard_timeout(pdf_path, use_ai=False, force_ai=False, timeout_seconds=base_timeout)
                except Exception as e:
                    non_ai_err = str(e)

                if enable_ai and has_key:
                    try:
                        financials_ai = _run_with_hard_timeout(
                            pdf_path,
                            use_ai=True,
                            force_ai=False,
                            timeout_seconds=ai_timeout,
                        )
                        if financials_ai is not None:
                            financials = financials_ai
                    except Exception as e:
                        ai_err = str(e)

            if financials is None:
                raise RuntimeError(f"pdf_extract_failed non_ai={non_ai_err} ai={ai_err}")
        finally:
            try:
                _PDF_ANALYSIS_SEM.release()
            except Exception:
                pass
        
        # Update report with extracted data and save metrics
        with session_scope() as s:
            r = s.get(Report, report_id)
            if not r:
                return

            # Clear existing children to avoid duplicates
            delete_report_children(report_id)

            r.updated_at = int(time.time())

            # Update period_end if extracted
            period_end = financials.report_period or r.period_end
            if financials.report_period:
                r.period_end = financials.report_period

            # Infer period_type from period_end (best-effort)
            if financials.report_period:
                if financials.report_period.endswith(("-03-31", "-06-30", "-09-30")):
                    r.period_type = "quarter"
                elif financials.report_period.endswith("-12-31"):
                    r.period_type = "annual"

            period_type = r.period_type
            company_id = r.company_id

            # Save extracted metrics to computed_metrics table
            from core.pdf_analyzer import compute_metrics_from_extracted

            computed = compute_metrics_from_extracted(financials) or {}

            def _is_pct_code(code: str) -> bool:
                return code in {"GROSS_MARGIN", "NET_MARGIN", "ROE", "ROA", "DEBT_ASSET"}

            def _is_reasonable(code: str, v: float | None) -> bool:
                try:
                    if v is None:
                        return False
                    fv = float(v)
                    if code in {"GROSS_MARGIN", "NET_MARGIN"}:
                        return -50.0 <= fv <= 100.0
                    if code in {"ROE", "ROA"}:
                        return -200.0 <= fv <= 500.0
                    if code in {"DEBT_ASSET"}:
                        return -50.0 <= fv <= 200.0
                    if _is_pct_code(code):
                        return -200.0 <= fv <= 500.0
                    if code in {"CURRENT_RATIO", "QUICK_RATIO"}:
                        return 0.0 <= fv <= 50.0
                    if code in {"ASSET_TURNOVER", "INVENTORY_TURNOVER", "RECEIVABLE_TURNOVER"}:
                        return 0.0 <= fv <= 1000.0
                    return True
                except Exception:
                    return False

            metric_meta: dict[str, tuple[str, str]] = {
                "GROSS_MARGIN": ("毛利率", "%"),
                "NET_MARGIN": ("净利率", "%"),
                "ROE": ("ROE (净资产收益率)", "%"),
                "ROA": ("ROA (总资产收益率)", "%"),
                "CURRENT_RATIO": ("流动比率", ""),
                "QUICK_RATIO": ("速动比率", ""),
                "DEBT_ASSET": ("资产负债率", "%"),
                "EQUITY_RATIO": ("产权比率", ""),
                "ASSET_TURNOVER": ("总资产周转率", ""),
                "INVENTORY_TURNOVER": ("存货周转率", ""),
                "RECEIVABLE_TURNOVER": ("应收账款周转率", ""),
            }

            metrics_to_save: list[tuple[str, str, float, str]] = []
            for code, (name, unit) in metric_meta.items():
                v = computed.get(code)
                if _is_reasonable(code, v):
                    metrics_to_save.append((code, name, float(v), unit))

            raw_metric_meta: dict[str, tuple[str, str, float | None]] = {
                "TOTAL_REVENUE": ("营业总收入", "", financials.revenue),
                "OPERATING_CASH_FLOW": ("经营现金流量净额", "", getattr(financials, "operating_cash_flow", None)),
                "IS.REVENUE": ("营业收入", "", financials.revenue),
                "IS.COST": ("营业成本", "", financials.cost),
                "IS.GROSS_PROFIT": ("毛利润", "", financials.gross_profit),
                "IS.NET_PROFIT": ("净利润", "", financials.net_profit),
                "CF.CFO": ("经营活动现金流净额", "", getattr(financials, "operating_cash_flow", None)),
                "BS.ASSET_TOTAL": ("资产总计", "", financials.total_assets),
                "BS.LIAB_TOTAL": ("负债合计", "", financials.total_liabilities),
                "BS.EQUITY_TOTAL": ("所有者权益合计", "", financials.total_equity),
                "BS.CURRENT_ASSETS": ("流动资产合计", "", financials.current_assets),
                "BS.CURRENT_LIAB": ("流动负债合计", "", financials.current_liabilities),
                "BS.CASH": ("货币资金", "", financials.cash),
                "BS.INVENTORY": ("存货", "", financials.inventory),
                "BS.RECEIVABLES": ("应收账款", "", financials.receivables),
                "BS.FIXED_ASSETS": ("固定资产", "", financials.fixed_assets),
            }
            for code, (name, unit, v) in raw_metric_meta.items():
                if v is None:
                    continue
                if _is_reasonable(code, v):
                    metrics_to_save.append((code, name, float(v), unit))

            # If ratio metrics are still empty but we extracted some raw amounts, do not hard-fail.
            raw_fields = [
                financials.revenue,
                financials.cost,
                financials.net_profit,
                financials.total_assets,
                financials.total_liabilities,
                financials.total_equity,
                financials.current_assets,
                financials.current_liabilities,
            ]
            has_some_raw = any(v is not None for v in raw_fields)

            for code, name, value, unit in metrics_to_save:
                s.add(
                    ComputedMetric(
                        report_id=report_id,
                        company_id=company_id,
                        period_end=period_end,
                        period_type=period_type,
                        metric_code=code,
                        metric_name=name,
                        value=value,
                        unit=unit,
                    )
                )

            if metrics_to_save or has_some_raw:
                r.status = "done"
                r.error_message = None
            else:
                r.status = "failed"
                r.error_message = "未能从PDF中提取到可用的财务指标"

            print(f"PDF analysis completed: {len(metrics_to_save)} metrics saved for report {report_id}")
    except Exception as e:
        print(f"PDF analysis error: {e}")
        import traceback
        traceback.print_exc()
        # Update report status to failed
        with session_scope() as s:
            r = s.get(Report, report_id)
            if r:
                r.status = "failed"
                msg = str(e)
                if "pdf_extract_timeout" in msg:
                    r.error_message = "PDF 解析超时（可能是扫描版/内容过大/OCR或AI耗时）。请稍后重试或更换更清晰的 PDF。"
                elif "ai_required_no_api_key" in msg or "missing_api_key" in msg:
                    r.error_message = "AI-only 解析需要配置 DASHSCOPE_API_KEY（千问）。请先配置后重试。"
                else:
                    r.error_message = f"PDF解析失败: {msg}"
                r.updated_at = int(time.time())


@app.post("/api/reports/upload")
async def upload_report(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    company_name: str = Form(""),
    market: str = Form(""),
    symbol: str = Form(""),
    period_type: str = Form("annual"),
    period_end: str = Form(None),
):
    """Upload a financial report file."""
    try:
        filename_in = file.filename or "upload"
        try:
            saved_path = save_uploaded_file_stream(filename=filename_in, fileobj=file.file, max_bytes=_MAX_UPLOAD_BYTES)
        except ValueError as e:
            if "upload_too_large" in str(e):
                raise HTTPException(status_code=413, detail="上传文件过大")
            raise
        
        # Determine period_end
        if not period_end:
            period_end = date.today().isoformat()
        
        final_company = company_name.strip() if company_name.strip() else "待识别"
        decoded_filename = file.filename or "upload"
        try:
            if "%" in decoded_filename:
                decoded_filename = unquote(decoded_filename)
        except Exception:
            decoded_filename = file.filename or "upload"
        report_name = f"{final_company} - {decoded_filename}"
        filetype = (file.filename or "").rsplit(".", 1)[-1].lower() if file.filename else ""
        
        symbol_in = (symbol or "").strip()
        market_in = (market or "").strip()
        symbol_norm = None
        market_norm = None
        company_id = None
        industry_code = None

        # Optional: bind upload to a company if user provides market+symbol.
        if symbol_in:
            try:
                market_norm = normalize_market(market_in or "CN")
                symbol_norm = normalize_symbol(market_norm, symbol_in)

                if final_company == "待识别" and symbol_norm:
                    report_name = f"{symbol_norm} - {decoded_filename}"

                try:
                    mkt = (market_norm or "CN").upper()
                    if mkt in {"US", "HK"}:
                        disable_proxies_for_process()
                        import yfinance as yf

                        yf_symbol = symbol_norm
                        if mkt == "HK" and not yf_symbol.upper().endswith(".HK"):
                            base = yf_symbol.replace(".HK", "")
                            yf_symbol = f"{base.zfill(4)}.HK" if base.isdigit() else f"{base}.HK"
                        t = yf.Ticker(yf_symbol)
                        info = {}
                        try:
                            info = t.info or {}
                        except Exception:
                            info = {}
                        industry_code = (info.get("industry") or info.get("sector") or None)
                    elif mkt == "CN":
                        disable_proxies_for_process()
                        import akshare as ak

                        code = symbol_norm.split(".")[0]
                        try:
                            idf = ak.stock_individual_info_em(symbol=code)
                            if idf is not None and not idf.empty and "item" in idf.columns and "value" in idf.columns:
                                row = idf[idf["item"].astype(str).str.contains("行业", na=False)]
                                if not row.empty:
                                    industry_code = str(row.iloc[0]["value"]).strip() or None
                        except Exception:
                            industry_code = None
                except Exception:
                    industry_code = None

                display_name = final_company if final_company != "待识别" else symbol_norm
                company_id = upsert_company(market=market_norm, symbol=symbol_norm, name=display_name, industry_code=industry_code)
            except Exception:
                symbol_norm = None
                market_norm = None
                company_id = None

        meta = {
            "upload_company_name": final_company,
            "upload_filename": file.filename,
            "upload_filetype": filetype,
            "upload_saved_path": str(saved_path),
            "upload_market": market_norm,
            "upload_symbol": symbol_norm,
            "upload_company_id": company_id,
        }
        
        # Create report record
        report_id = upsert_report_file_upload(
            upload_company_name=final_company,
            report_name=report_name,
            period_type=period_type,
            period_end=period_end,
            source_meta=meta,
        )

        # Bind report to company if available.
        if company_id:
            try:
                with session_scope() as s:
                    r = s.get(Report, report_id)
                    if r:
                        r.company_id = company_id
                        r.market = market_norm
                        r.updated_at = int(time.time())
            except Exception:
                pass

        if filetype != "pdf":
            with session_scope() as s:
                r = s.get(Report, report_id)
                if r:
                    r.status = "failed"
                    r.error_message = "仅支持上传 PDF 文件进行解析"
                    r.updated_at = int(time.time())
            return {"report_id": report_id, "message": "上传成功，但仅支持PDF解析", "status": "failed"}

        with session_scope() as s:
            r = s.get(Report, report_id)
            if r:
                r.status = "running"
                r.error_message = None
                r.updated_at = int(time.time())

        threading.Thread(target=run_pdf_analysis_in_background, args=(report_id, str(saved_path)), daemon=True).start()

        return {"report_id": report_id, "message": "上传成功，正在分析中", "status": "running"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"上传失败: {str(e)}")



def _query_latest_period(market: str, symbol_norm: str) -> tuple[str | None, str]:
    """Query AkShare for the latest available report period date (annual + interim).
    Returns (period_end_date, period_type)."""
    try:
        disable_proxies_for_process()
        import akshare as ak
        mkt = (market or '').upper()

        if mkt == 'HK':
            code = symbol_norm.replace('.HK', '').zfill(5)
            annual_latest_ds = None
            interim_latest_ds = None
            for indicator, store in [('年度', 'annual'), ('半年度', 'interim')]:
                try:
                    df = ak.stock_financial_hk_report_em(stock=code, symbol='利润表', indicator=indicator)
                    if df is not None and not df.empty and 'REPORT_DATE' in df.columns:
                        latest = df['REPORT_DATE'].max()
                        ds = str(latest.date()) if hasattr(latest, 'date') else str(latest)[:10]
                        if store == 'annual':
                            annual_latest_ds = ds
                        else:
                            interim_latest_ds = ds
                except Exception:
                    pass

            ds = None
            # Take whichever is newer
            candidates = [d for d in [annual_latest_ds, interim_latest_ds] if d]
            if candidates:
                ds = max(candidates)

            # Note: we do NOT use indicator table to upgrade period_end here.
            # Even if indicator shows current-year data, statement rows lag behind.
            # Using a period_end that has no statement data produces incorrect metrics.
            # The pipeline will still use indicator data for key ratio overrides.
            if ds:
                pt = 'interim' if '-06-30' in ds else 'annual'
                return ds, pt

        elif mkt == 'US':
            base = symbol_norm.split('.')[0].upper()
            all_dates = []
            for indicator in ['年报', '中报']:
                try:
                    df = ak.stock_financial_us_report_em(stock=base, symbol='综合损益表', indicator=indicator)
                    if df is not None and not df.empty and 'REPORT_DATE' in df.columns:
                        all_dates.append(df['REPORT_DATE'].max())
                except Exception:
                    pass
            if all_dates:
                latest = max(all_dates)
                ds = str(latest.date()) if hasattr(latest, 'date') else str(latest)[:10]
                pt = 'interim' if '-06-30' in ds else 'annual'
                return ds, pt
            try:
                ind_df = ak.stock_financial_us_analysis_indicator_em(symbol=base, indicator='年报')
                if ind_df is not None and not ind_df.empty:
                    for col in ('STD_REPORT_DATE', 'REPORT_DATE'):
                        if col in ind_df.columns:
                            latest = ind_df[col].max()
                            ds = str(latest.date()) if hasattr(latest, 'date') else str(latest)[:10]
                            pt = 'interim' if '-06-30' in ds else 'annual'
                            return ds, pt
            except Exception:
                pass

        elif mkt == 'CN':
            code = symbol_norm.split('.')[0]
            try:
                df = ak.stock_financial_abstract_ths(symbol=code, indicator='按报告期')
                if df is not None and not df.empty and '报告期' in df.columns:
                    periods = df['报告期'].unique()
                    annual = [p for p in periods if '12-31' in str(p)]
                    interim = [p for p in periods if '06-30' in str(p)]
                    all_p = sorted(
                        [str(p)[:10] for p in (annual + interim)],
                        reverse=True,
                    )
                    if all_p:
                        ds = all_p[0]
                        pt = 'interim' if '-06-30' in ds else 'annual'
                        return ds, pt
            except Exception:
                pass
            try:
                ratio_df = ak.stock_financial_analysis_indicator(symbol=code)
                if ratio_df is not None and not ratio_df.empty and '日期' in ratio_df.columns:
                    latest = ratio_df['日期'].max()
                    ds = str(latest.date()) if hasattr(latest, 'date') else str(latest)[:10]
                    pt = 'interim' if '-06-30' in ds else 'annual'
                    return ds, pt
            except Exception:
                pass

    except Exception:
        pass
    return None, 'annual'

@app.post("/api/reports/fetch")
def fetch_market_report(
    background_tasks: BackgroundTasks,
    symbol: str,
    market: str = "CN",
    company_name: str | None = None,
    period_type: str = "annual",
    period_end: str | None = None,
):
    """Fetch financial report from market data and start analysis."""
    try:
        disable_proxies_for_process()
        
        # Normalize symbol
        symbol_norm = normalize_symbol(market, symbol)

        # Query latest available period from data source (annual + interim), fallback to year-1
        queried_latest, queried_ptype = _query_latest_period(market, symbol_norm) if not (period_end or "").strip() else (None, "annual")
        today = _dt.date.today()
        fallback_period_end = f"{today.year - 1}-12-31"
        latest_period_end = queried_latest or fallback_period_end
        if not (period_type or "").strip() or period_type == "annual":
            period_type = queried_ptype or "annual"
        period_end_norm = (period_end or "").strip()
        if not period_end_norm:
            period_end_norm = latest_period_end
        elif (period_type or "").lower() == "annual":
            try:
                if _dt.date.fromisoformat(period_end_norm) < _dt.date.fromisoformat(latest_period_end):
                    period_end_norm = latest_period_end
            except Exception:
                period_end_norm = latest_period_end

        display_name = (company_name or "").strip() or symbol_norm

        industry_code = None
        try:
            mkt = (market or "CN").upper()
            if mkt in {"US", "HK"}:
                disable_proxies_for_process()
                import yfinance as yf

                yf_symbol = symbol_norm
                if mkt == "HK" and not yf_symbol.upper().endswith(".HK"):
                    base = yf_symbol.replace(".HK", "")
                    yf_symbol = f"{base.zfill(4)}.HK" if base.isdigit() else f"{base}.HK"
                t = yf.Ticker(yf_symbol)
                info = {}
                try:
                    info = t.info or {}
                except Exception:
                    info = {}
                industry_code = (info.get("industry") or info.get("sector") or None)
            elif mkt == "CN":
                disable_proxies_for_process()
                import akshare as ak

                code = symbol_norm.split(".")[0]
                try:
                    idf = ak.stock_individual_info_em(symbol=code)
                    if idf is not None and not idf.empty and "item" in idf.columns and "value" in idf.columns:
                        row = idf[idf["item"].astype(str).str.contains("行业", na=False)]
                        if not row.empty:
                            industry_code = str(row.iloc[0]["value"]).strip() or None
                except Exception:
                    industry_code = None
        except Exception:
            industry_code = None
        
        # Create company record
        company_id = upsert_company(market=market, symbol=symbol_norm, name=display_name, industry_code=industry_code)
        
        # Create report record
        report_id = upsert_report_market_fetch(
            company_id=company_id,
            report_name=f"{display_name} {period_end_norm}",
            market=market,
            period_type=period_type,
            period_end=period_end_norm,
            source_meta={"symbol": symbol_norm, "market": market, "company_name": display_name},
        )
        
        # Start analysis in background
        threading.Thread(target=run_analysis_in_background, args=(report_id,), daemon=True).start()
        
        return {
            "report_id": report_id, 
            "message": "已开始获取财报数据，分析正在进行中",
            "status": "running"
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"获取失败: {str(e)}")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
