from __future__ import annotations

import time
import uuid

from sqlalchemy import Float, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


class Base(DeclarativeBase):
    pass


class Company(Base):
    __tablename__ = "companies"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    market: Mapped[str] = mapped_column(String, index=True)
    symbol: Mapped[str] = mapped_column(String, index=True)
    name: Mapped[str | None] = mapped_column(String, nullable=True)
    currency: Mapped[str | None] = mapped_column(String, nullable=True)
    industry_code: Mapped[str | None] = mapped_column(String, nullable=True)
    created_at: Mapped[int] = mapped_column(Integer, default=lambda: int(time.time()))
    updated_at: Mapped[int] = mapped_column(Integer, default=lambda: int(time.time()))

    __table_args__ = (UniqueConstraint("market", "symbol", name="uq_companies_market_symbol"),)

    reports: Mapped[list[Report]] = relationship("Report", back_populates="company")


class Report(Base):
    __tablename__ = "reports"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    natural_key: Mapped[str] = mapped_column(String, unique=True, index=True)

    company_id: Mapped[str | None] = mapped_column(String, ForeignKey("companies.id"), nullable=True, index=True)
    report_name: Mapped[str] = mapped_column(String)

    source_type: Mapped[str] = mapped_column(String, index=True)
    source_meta: Mapped[str] = mapped_column(Text, default="{}")

    market: Mapped[str | None] = mapped_column(String, nullable=True, index=True)
    period_type: Mapped[str] = mapped_column(String, index=True)
    period_start: Mapped[str | None] = mapped_column(String, nullable=True)
    period_end: Mapped[str] = mapped_column(String, index=True)

    status: Mapped[str] = mapped_column(String, index=True, default="pending")
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)

    created_at: Mapped[int] = mapped_column(Integer, default=lambda: int(time.time()))
    updated_at: Mapped[int] = mapped_column(Integer, default=lambda: int(time.time()))

    company: Mapped[Company | None] = relationship("Company", back_populates="reports")
    jobs: Mapped[list[Job]] = relationship("Job", back_populates="report")

    statements: Mapped[list[Statement]] = relationship("Statement", back_populates="report")
    items: Mapped[list[StatementItem]] = relationship("StatementItem", back_populates="report")
    metrics: Mapped[list[ComputedMetric]] = relationship("ComputedMetric", back_populates="report")
    alerts: Mapped[list[Alert]] = relationship("Alert", back_populates="report")


class Job(Base):
    __tablename__ = "jobs"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    report_id: Mapped[str] = mapped_column(String, ForeignKey("reports.id"), index=True)

    job_type: Mapped[str] = mapped_column(String, index=True)
    status: Mapped[str] = mapped_column(String, index=True, default="pending")

    started_at: Mapped[int | None] = mapped_column(Integer, nullable=True)
    ended_at: Mapped[int | None] = mapped_column(Integer, nullable=True)

    log: Mapped[str | None] = mapped_column(Text, nullable=True)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)

    report: Mapped[Report] = relationship("Report", back_populates="jobs")


class Watchlist(Base):
    __tablename__ = "watchlist"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    company_id: Mapped[str] = mapped_column(String, ForeignKey("companies.id"), unique=True)
    market: Mapped[str] = mapped_column(String, index=True)
    note: Mapped[str | None] = mapped_column(String, nullable=True)
    created_at: Mapped[int] = mapped_column(Integer, default=lambda: int(time.time()))
    updated_at: Mapped[int] = mapped_column(Integer, default=lambda: int(time.time()))


class PortfolioPosition(Base):
    __tablename__ = "portfolio_positions"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    market: Mapped[str] = mapped_column(String, index=True)
    symbol: Mapped[str] = mapped_column(String, index=True)
    name: Mapped[str | None] = mapped_column(String, nullable=True)

    quantity: Mapped[float] = mapped_column(Float, default=0.0)
    avg_cost: Mapped[float] = mapped_column(Float, default=0.0)

    target_buy_price: Mapped[float | None] = mapped_column(Float, nullable=True)
    target_sell_price: Mapped[float | None] = mapped_column(Float, nullable=True)

    created_at: Mapped[int] = mapped_column(Integer, default=lambda: int(time.time()))
    updated_at: Mapped[int] = mapped_column(Integer, default=lambda: int(time.time()))

    __table_args__ = (UniqueConstraint("market", "symbol", name="uq_portfolio_positions_market_symbol"),)


class PortfolioTrade(Base):
    __tablename__ = "portfolio_trades"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    position_id: Mapped[str] = mapped_column(String, ForeignKey("portfolio_positions.id"), index=True)

    side: Mapped[str] = mapped_column(String)  # BUY / SELL
    price: Mapped[float] = mapped_column(Float)
    quantity: Mapped[float] = mapped_column(Float)
    amount: Mapped[float] = mapped_column(Float)
    fee: Mapped[float] = mapped_column(Float, default=0.0)
    source: Mapped[str] = mapped_column(String, default="manual")  # manual / auto_strategy / auto_order

    created_at: Mapped[int] = mapped_column(Integer, default=lambda: int(time.time()))


class PortfolioAutoTrade(Base):
    __tablename__ = "portfolio_auto_trades"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    position_id: Mapped[str] = mapped_column(String, ForeignKey("portfolio_positions.id"), index=True)

    side: Mapped[str] = mapped_column(String)  # BUY / SELL
    trigger_price: Mapped[float] = mapped_column(Float)
    quantity: Mapped[float] = mapped_column(Float)
    status: Mapped[str] = mapped_column(String, index=True, default="PENDING")  # PENDING / EXECUTED / CANCELLED

    created_at: Mapped[int] = mapped_column(Integer, default=lambda: int(time.time()))
    executed_at: Mapped[int | None] = mapped_column(Integer, nullable=True)
    executed_price: Mapped[float | None] = mapped_column(Float, nullable=True)


class PortfolioAgentConfig(Base):
    __tablename__ = "portfolio_agent_configs"

    id: Mapped[str] = mapped_column(String, primary_key=True, default="default")
    enabled: Mapped[str] = mapped_column(String, default="0")  # 0 / 1
    target_profit: Mapped[float | None] = mapped_column(Float, nullable=True)
    deadline_ts: Mapped[int | None] = mapped_column(Integer, nullable=True)
    min_buy_quantity: Mapped[float] = mapped_column(Float, default=10000.0)
    last_run_at: Mapped[int | None] = mapped_column(Integer, nullable=True)
    last_action: Mapped[str | None] = mapped_column(String, nullable=True)
    last_status: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[int] = mapped_column(Integer, default=lambda: int(time.time()))
    updated_at: Mapped[int] = mapped_column(Integer, default=lambda: int(time.time()))


class MappingRule(Base):
    __tablename__ = "mapping_rules"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    market: Mapped[str | None] = mapped_column(String, nullable=True)
    pattern: Mapped[str] = mapped_column(String, index=True)
    standard_item_code: Mapped[str] = mapped_column(String)
    standard_item_name: Mapped[str] = mapped_column(String)
    confidence: Mapped[float | None] = mapped_column(Float, nullable=True)
    created_at: Mapped[int] = mapped_column(Integer, default=lambda: int(time.time()))


class Statement(Base):
    __tablename__ = "statements"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    report_id: Mapped[str] = mapped_column(String, ForeignKey("reports.id"), index=True)
    company_id: Mapped[str | None] = mapped_column(String, ForeignKey("companies.id"), nullable=True, index=True)

    statement_type: Mapped[str] = mapped_column(String, index=True)  # bs/is/cf
    period_end: Mapped[str] = mapped_column(String, index=True)
    period_type: Mapped[str] = mapped_column(String, index=True)  # quarter/annual
    source: Mapped[str] = mapped_column(String, index=True)

    raw_payload: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[int] = mapped_column(Integer, default=lambda: int(time.time()))

    report: Mapped[Report] = relationship("Report", back_populates="statements")


class StatementItem(Base):
    __tablename__ = "statement_items"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    statement_id: Mapped[str] = mapped_column(String, ForeignKey("statements.id"), index=True)
    report_id: Mapped[str] = mapped_column(String, ForeignKey("reports.id"), index=True)
    company_id: Mapped[str | None] = mapped_column(String, ForeignKey("companies.id"), nullable=True, index=True)

    statement_type: Mapped[str] = mapped_column(String, index=True)
    period_end: Mapped[str] = mapped_column(String, index=True)
    period_type: Mapped[str] = mapped_column(String, index=True)

    standard_item_code: Mapped[str] = mapped_column(String, index=True)
    standard_item_name: Mapped[str] = mapped_column(String)
    value: Mapped[float | None] = mapped_column(Float, nullable=True)
    currency: Mapped[str | None] = mapped_column(String, nullable=True)

    original_item_name: Mapped[str | None] = mapped_column(String, nullable=True)
    mapping_confidence: Mapped[float | None] = mapped_column(Float, nullable=True)

    report: Mapped[Report] = relationship("Report", back_populates="items")


class ComputedMetric(Base):
    __tablename__ = "computed_metrics"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    report_id: Mapped[str] = mapped_column(String, ForeignKey("reports.id"), index=True)
    company_id: Mapped[str | None] = mapped_column(String, ForeignKey("companies.id"), nullable=True, index=True)

    period_end: Mapped[str] = mapped_column(String, index=True)
    period_type: Mapped[str] = mapped_column(String, index=True)

    metric_code: Mapped[str] = mapped_column(String, index=True)
    metric_name: Mapped[str] = mapped_column(String)
    value: Mapped[float | None] = mapped_column(Float, nullable=True)
    unit: Mapped[str | None] = mapped_column(String, nullable=True)
    calc_trace: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[int] = mapped_column(Integer, default=lambda: int(time.time()))

    report: Mapped[Report] = relationship("Report", back_populates="metrics")


class Alert(Base):
    __tablename__ = "alerts"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    report_id: Mapped[str] = mapped_column(String, ForeignKey("reports.id"), index=True)
    company_id: Mapped[str | None] = mapped_column(String, ForeignKey("companies.id"), nullable=True, index=True)

    period_end: Mapped[str] = mapped_column(String, index=True)
    period_type: Mapped[str] = mapped_column(String, index=True)

    alert_code: Mapped[str] = mapped_column(String, index=True)
    level: Mapped[str] = mapped_column(String, index=True)
    title: Mapped[str] = mapped_column(String)
    message: Mapped[str] = mapped_column(Text)
    evidence: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[int] = mapped_column(Integer, default=lambda: int(time.time()))

    report: Mapped[Report] = relationship("Report", back_populates="alerts")
