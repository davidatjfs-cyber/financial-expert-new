# 股票买卖信号优化方案

## 一、当前系统架构

```
get_stock_indicators()
  ├── 数据源: 腾讯行情 > yfinance > AkShare > Stooq
  ├── 历史数据: 约800天日线
  ├── 技术指标: MA5/20/60, RSI14, MACD, ATR14, Slope
  └── 信号判定: 4条件AND门控 → buy_price_aggressive_ok
```

## 二、当前买卖逻辑详解

### 买入条件（aggressive_ok）— 4条件全满足才买

| # | 条件 | 代码逻辑 | 问题 |
|---|------|----------|------|
| 1 | 价格 > MA60 | `last_close > ma60_now` | 合理，但缺少量价配合 |
| 2 | MA60趋势向上 | `slope_pct > 0` | **slope计算有bug，美股/港股数据异常** |
| 3 | 价格 ≈ MA20 (±2%) | `abs(close-ma20)/ma20 <= 0.02` | 范围过窄，很多合理回调买点被排除 |
| 4 | RSI低位拐头 | `rsi_yesterday<40 且 rsi_before>rsi_yesterday<rsi_today` | **RSI<40阈值过严，优质股极少触发** |

### 卖出条件 — 三选一触发

| # | 条件 | 代码逻辑 | 问题 |
|---|------|----------|------|
| A | RSI>70 + 顶背离 | `rsi>70 且 price>历史高点 且 rsi<历史高点rsi` | 条件太严，错过普通止盈时机 |
| B | 跌破MA20 | `last_close < ma20` | **几乎永远为true，信号失真** |
| C | 止损: price-2×ATR | `last_low <= close-2*ATR` | **高波动股止损线过低（NVDA跌91%才止损）** |

## 三、核心问题诊断

### 问题1：Slope计算 — 导致趋势判断完全失准

**位置**: `api.py:4608-4612`

```python
shift_n = 5
slope_raw_s = (ma60 - ma60.shift(shift_n)) / float(shift_n)
slope_pct_s = (slope_raw_s / ma60) * 100
```

**问题**: `slope_pct = ((MA60_today - MA60_5天前) / 5) / MA60 × 100`

这个公式算出的是"MA60每天变化占MA60的百分比"，对A股有效是因为A股股价在10-2000元区间，MA60变化平缓。但：
- 美股NVDA: MA60≈$117, 5天MA60差值≈$98 → slope_pct = (98/5)/117×100 = **16.8%/天** — 荒谬
- 根因：这不是真正的趋势斜率，只是5天窗口的差分占比

**实际影响**:
- 美股/港股slope_pct经常是-12%~+84%，导致slope_advice永远不是"放心买"
- A股贵州茅台 slope_pct=0.074%，却在"小心买"区间（0~0.1%），几乎不会触发"放心买"（0.2~0.3%）

### 问题2：RSI反弹阈值过严 — 几乎永不触发

**位置**: `api.py:4763`

```python
is_low_position = bool(float(rsi_yesterday) < 40)
```

RSI<40才认为"低位"，而大多数优质股票即使回调RSI也很少跌破40。以泡泡玛特为例，2025年4月回调最低RSI也在42-45之间，永远无法触发买入。

**实际影响**: 4个买入条件中RSI是最难满足的一个，直接导致 `aggressive_ok` 几乎永远为false。

### 问题3：MA20±2%入场窗口过窄

**位置**: `api.py:4964`

```python
approx_ma20 = bool(abs(float(last_close) - float(ma20_now)) / max(abs(float(ma20_now)), 1e-9) <= 0.02)
```

要求价格在MA20的±2%以内。但很多有效买点是MA20附近±5%的回调，比如：
- 股价从高位回调至MA20附近但还差3%，被排除
- 波动较大的股票（科技/医药）日内波动就超过2%

### 问题4：卖出信号"跌破MA20"几乎永远为true

**位置**: `api.py:4997`

```python
price_break_ma20 = bool(float(last_close) < float(ma20_now))
```

在正常行情中，股价有大约50%的时间在MA20以下（MA20本身就会被上穿下穿）。这个条件在多数股票上都为true，导致 `sell_ok` 几乎永远是true。

### 问题5：止损线2×ATR对高波动股无效

NVDA: ATR14=$99 → 止损线 = $216-2×99 = $18（跌91%）
泡泡玛特: 如果ATR较大，同样止损线过低

**根因**: ATR本身对高价高波动股会产生非常大的绝对值，2×ATR是标准做法但缺少下限保护。

### 问题6：买入信号未考虑成交量

`signal_vol_gt_ma5` 和 `signal_vol_gt_ma10` 已经计算但未纳入买入条件。放量突破是技术分析的基本确认信号。

### 问题7：slope_advice阈值不合理

```python
0 < slope_pct < 0.1 → "小心买"
0.2 <= slope_pct <= 0.3 → "放心买"
0.1~0.2 → "小心买"（else分支）
```

"放心买"的窗口只有0.2%~0.3%这一个极窄区间，且0.1%~0.2%之间没有专门处理。

### 问题8：缺少KDJ指标

KDJ（随机指标）是国内量化系统最常用的短线买卖指标之一，当前系统完全没有。

### 问题9：缺少布林带

布林带（Bollinger Bands）能有效判断超买超卖和突破，当前系统没有。

### 问题10：卖出信号缺少MACD死叉

MACD死叉是经典的卖出信号，当前系统已计算MACD但未用于卖出判断。

## 四、优化方案

### 方案概览：多层信号评分系统

将"全有全无"的布尔门控改为**多维度评分制**，综合8个维度产生0-100分的买卖信号强度。

---

### 4.1 修复Slope计算 — 使用线性回归

**替换**: 将5天差分改为对MA60最近20天做**线性回归**，取回归斜率的日化百分比。

```python
# 替换 api.py:4608-4612
def _calc_slope_pct(series, window=20):
    """线性回归斜率，返回日化百分比变化"""
    import numpy as np
    s = series.dropna().tail(window)
    if len(s) < 10:
        return 0.0
    y = s.values.astype(float)
    x = np.arange(len(y), dtype=float)
    # 最小二乘回归
    n = len(y)
    slope = (n * np.sum(x * y) - np.sum(x) * np.sum(y)) / (n * np.sum(x**2) - np.sum(x)**2)
    mean_val = np.mean(y)
    if mean_val == 0:
        return 0.0
    return (slope / mean_val) * 100  # 日均变化百分比
```

**效果**: 
- NVDA: slope_pct从83.8%降到合理的~0.3%/天
- 所有市场统一尺度，slope_advice阈值恢复正常意义

### 4.2 新增技术指标

#### KDJ随机指标
```python
def _kdj(df, n=9, m1=3, m2=3):
    """KDJ随机指标"""
    low_n = df['low'].rolling(window=n).min()
    high_n = df['high'].rolling(window=n).max()
    rsv = (df['close'] - low_n) / (high_n - low_n) * 100
    k = rsv.ewm(com=m1-1, adjust=False).mean()
    d = k.ewm(com=m2-1, adjust=False).mean()
    j = 3 * k - 2 * d
    return k, d, j
```

#### 布林带
```python
def _bollinger(series, window=20, num_std=2):
    """布林带"""
    mid = series.rolling(window=window).mean()
    std = series.rolling(window=window).std()
    upper = mid + num_std * std
    lower = mid - num_std * std
    pct_b = (series - lower) / (upper - lower)  # %B指标
    return upper, mid, lower, pct_b
```

### 4.3 评分制买卖信号

#### 买入评分（0-100分）

| 维度 | 权重 | 满分条件 | 得分逻辑 |
|------|------|----------|----------|
| **趋势方向** | 20分 | MA60上升，Slope>0 | Slope>0.2%/天=20分; 0~0.2%=10分; <0=0分 |
| **均线多头排列** | 15分 | MA5>MA20>MA60 | 三线多头=15分; 两线=10分; 其他=0分 |
| **价格位置** | 15分 | 价格回调至MA20附近 | 在MA20±5%内=15分; ±8%=10分; >MA20+8%=5分; <MA60=0分 |
| **RSI状态** | 15分 | RSI低位反弹 | RSI<30且拐头=15分; 30-45且拐头=12分; 45-55=8分; >70=0分 |
| **KDJ金叉** | 10分 | J值从低位上穿 | J<20且金叉=10分; J<50且K>D=7分; 其他=0分 |
| **成交量确认** | 10分 | 放量 | vol>vol_ma5=10分; vol>vol_ma10=7分; 缩量=0分 |
| **MACD信号** | 10分 | MACD金叉或柱翻红 | DIF>DEA且柱翻红=10分; DIF>DEA=7分; 柱收窄=4分 |
| **布林带位置** | 5分 | 触及下轨反弹 | 价格在下轨附近反弹=5分; 中轨以下=3分 |

**买入信号等级**:
- 80-100分: **强烈买入**（绿色）
- 60-79分: **建议买入**（浅绿）
- 40-59分: **观望**（黄色）
- <40分: **不建议买入**（灰色）

#### 卖出评分（0-100分）

| 维度 | 权重 | 满分条件 |
|------|------|----------|
| **RSI超买** | 20分 | RSI>70 |
| **MACD死叉** | 15分 | DIF下穿DEA |
| **跌破MA20** | 15分 | 价格<MA20 |
| **KDJ超买死叉** | 15分 | J>80且K下穿D |
| **布林带** | 10分 | 价格触及上轨或突破上轨后回落 |
| **顶背离** | 15分 | 价格新高但RSI/MACD不创新高 |
| **止损触发** | 10分 | 价格跌破max(close-2×ATR, close×0.85) |

**卖出信号等级**:
- 70-100分: **强烈卖出**（红色）
- 50-69分: **建议减仓**（橙色）
- <50分: **继续持有**（灰色）

### 4.4 止损线修正

```python
# 原代码
stop_line = float(last_close) - 2 * float(atr14)

# 修正：增加最大止损比例保护
max_loss_pct = 0.15  # 最大止损15%
atr_stop = float(last_close) - 2 * float(atr14)
pct_stop = float(last_close) * (1 - max_loss_pct)
stop_line = max(atr_stop, pct_stop)  # 取两者中较高的（更保守的）
```

### 4.5 Slope_advice阈值调整

```python
# 基于线性回归后的slope_pct新阈值
if slope_pct < 0:
    slope_advice = "不要买"
elif 0 <= slope_pct < 0.05:
    slope_advice = "小心买"      # 趋势刚起步
elif 0.05 <= slope_pct < 0.2:
    slope_advice = "放心买"      # 稳定上升趋势
elif 0.2 <= slope_pct < 0.5:
    slope_advice = "小心买"      # 加速上涨，注意回调
elif slope_pct >= 0.5:
    slope_advice = "有危险"      # 过热
```

### 4.6 RSI反弹条件放宽

```python
# 原代码
is_low_position = bool(float(rsi_yesterday) < 40)

# 修正：分级判定
if rsi_yesterday < 30:
    is_low_position = True       # 超卖区域，强烈反弹信号
elif rsi_yesterday < 45:
    is_low_position = True       # 弱势区域，有效反弹
elif rsi_yesterday < 55 and rsi_before_yesterday > rsi_yesterday:
    is_low_position = True       # 从较高位快速回落后的反弹
else:
    is_low_position = False
```

### 4.7 新增数据充分性检查

```python
# 在 get_stock_indicators 中增加
data_sufficient = len(df) >= 60
data_quality = "full" if len(df) >= 120 else "partial" if len(df) >= 60 else "insufficient"

if not data_sufficient:
    # 在响应中标记数据不足
    buy_reason = f"数据不足（仅{len(df)}天，需60天以上），信号不可靠"
```

## 五、API响应扩展

```python
# 新增字段
class StockIndicatorsResponse(BaseModel):
    # ... 现有字段 ...
    
    # 新增评分系统
    buy_score: int = None          # 0-100
    buy_grade: str = None          # 强烈买入/建议买入/观望/不建议
    sell_score: int = None         # 0-100
    sell_grade: str = None         # 强烈卖出/建议减仓/继续持有
    
    # 新增指标
    kdj_k: float = None
    kdj_d: float = None
    kdj_j: float = None
    boll_upper: float = None
    boll_mid: float = None
    boll_lower: float = None
    boll_pct_b: float = None      # %B：0=下轨，1=上轨
    
    # 数据质量
    data_points: int = None        # 历史数据天数
    data_quality: str = None       # full/partial/insufficient
    
    # 评分明细
    buy_score_details: dict = None  # 各维度得分详情
    sell_score_details: dict = None
```

## 六、实施优先级

| 优先级 | 改动 | 影响 | 工作量 |
|--------|------|------|--------|
| P0 | 修复Slope计算（线性回归） | 修复美股/港股趋势判断 | 小 |
| P0 | RSI阈值放宽(40→45) | 买入信号可触发性大幅提升 | 极小 |
| P0 | 止损线上限(15%) | 防止高波动股止损失效 | 极小 |
| P1 | 新增KDJ指标 | 短线买卖点更精准 | 中 |
| P1 | 新增布林带 | 超买超卖判断更完整 | 中 |
| P1 | 评分制替换布尔门控 | 从全有全无变为分级行动建议 | 大 |
| P2 | 成交量纳入买入条件 | 减少假突破 | 小 |
| P2 | MACD纳入卖出条件 | 卖出信号更及时 | 小 |
| P2 | 数据充分性检查 | 避免数据不足时给误导信号 | 小 |

## 七、预期效果

### 改进前（当前）

- 美股/港股: slope_pct异常 → 趋势判断错误 → 买入信号永远不触发
- A股: RSI<40太严 → 4个条件永远差1个 → 几乎永远无法买入
- 卖出: 跌破MA20几乎永远true → 卖出信号无意义
- 用户感知: "系统说不要买，但实际涨了" 或 "系统说卖，但其实只是正常波动"

### 改进后

- 所有市场: slope统一用线性回归，趋势判断准确
- RSI放宽+KDJ辅助: 买入信号在合理回调时能及时触发
- 评分制: 用户看到"72分-建议买入"而非二元的"不能买"
- 卖出: 多维度综合评分，不再是单一条件误触
- 止损: 最高15%保护，不会出现"跌91%才止损"的荒谬情况
