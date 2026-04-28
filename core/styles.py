from __future__ import annotations

GLOBAL_CSS = """
<style>
@import url('https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700;1,9..40,400&display=swap');

/* ========== OBSIDIAN — iPhone 17 Dark Luxury Theme ========== */

:root {
    --bg-void: #000000;
    --bg-page: #050505;
    --bg-surface: #0C0C0E;
    --bg-elevated: #141416;
    --bg-hover: #1A1A1E;

    --accent: #C9A96E;
    --accent-dim: rgba(201, 169, 110, 0.12);
    --accent-glow: rgba(201, 169, 110, 0.06);
    --accent-soft: #A88B5A;

    --green: #3E7C5A;
    --green-bg: rgba(62, 124, 90, 0.12);
    --red: #C45454;
    --red-bg: rgba(196, 84, 84, 0.12);
    --yellow: #D4A84B;
    --yellow-bg: rgba(212, 168, 75, 0.12);
    --blue: #6B8AB8;
    --blue-bg: rgba(107, 138, 184, 0.12);

    --text-1: #F5F5F7;
    --text-2: #8E8E93;
    --text-3: #48484A;
    --text-4: #2C2C2E;

    --border: rgba(255, 255, 255, 0.06);
    --border-accent: rgba(201, 169, 110, 0.2);

    --font: -apple-system, 'DM Sans', 'SF Pro Display', 'SF Pro Text', system-ui, sans-serif;
    --font-mono: 'SF Mono', 'Fira Code', ui-monospace, monospace;

    --radius-xs: 8px;
    --radius-sm: 12px;
    --radius-md: 16px;
    --radius-lg: 20px;
    --radius-xl: 24px;

    --space-1: 4px;
    --space-2: 8px;
    --space-3: 12px;
    --space-4: 16px;
    --space-5: 20px;
    --space-6: 24px;
    --space-8: 32px;
    --space-10: 40px;
    --space-12: 48px;

    --safe-top: env(safe-area-inset-top, 0px);
    --safe-bottom: env(safe-area-inset-bottom, 0px);
    --safe-left: env(safe-area-inset-left, 0px);
    --safe-right: env(safe-area-inset-right, 0px);
}

/* ===== Reset & Base ===== */
html, body, [class*="css"] {
    font-family: var(--font) !important;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
    color: var(--text-1);
    background: var(--bg-void);
    text-size-adjust: 100%;
    -webkit-text-size-adjust: 100%;
}

.stApp {
    background: var(--bg-void);
}

.stApp, .stApp p, .stApp span, .stApp div, .stApp label {
    color: var(--text-1);
}

.stApp h1, .stApp h2, .stApp h3, .stApp h4, .stApp h5, .stApp h6 {
    color: var(--text-1) !important;
}

.stMarkdown, .stMarkdown p, [data-testid="stMarkdownContainer"] p {
    color: var(--text-1) !important;
}

/* ===== Hide Streamlit Chrome ===== */
#MainMenu, footer { visibility: hidden; }
.stDeployButton { display: none; }
[data-testid="stSidebarNav"] { display: none !important; }

/* ===== Sidebar Toggle (Hamburger) ===== */
[data-testid="stSidebarCollapsedControl"],
[data-testid="collapsedControl"] {
    visibility: visible !important;
    display: flex !important;
    position: fixed !important;
    top: calc(var(--safe-top) + 12px) !important;
    left: 12px !important;
    z-index: 999999 !important;
    background: var(--bg-surface) !important;
    border: 1px solid var(--border) !important;
    border-radius: var(--radius-sm) !important;
    padding: 6px !important;
    backdrop-filter: blur(20px) !important;
    -webkit-backdrop-filter: blur(20px) !important;
}

[data-testid="stSidebarCollapsedControl"] button,
[data-testid="collapsedControl"] button {
    min-width: 44px !important;
    min-height: 44px !important;
    padding: 6px !important;
}

[data-testid="stSidebarCollapsedControl"] svg,
[data-testid="collapsedControl"] svg {
    width: 22px !important;
    height: 22px !important;
    color: var(--text-2) !important;
}

/* ===== Main Content Area ===== */
.main .block-container {
    padding: var(--space-8) var(--space-6);
    max-width: 960px;
    background: var(--bg-void);
}

/* ===== Sidebar ===== */
[data-testid="stSidebar"] {
    background: var(--bg-surface) !important;
    border-right: 1px solid var(--border) !important;
}

[data-testid="stSidebar"] > div:first-child {
    padding: var(--space-6) var(--space-4);
    background: var(--bg-surface) !important;
}

.sidebar-title {
    font-family: var(--font);
    font-size: 0.8125rem;
    font-weight: 600;
    color: var(--accent);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    margin-bottom: var(--space-6);
    padding: var(--space-4) var(--space-4);
    background: var(--accent-dim);
    border-radius: var(--radius-sm);
    border: 1px solid var(--border-accent);
    display: flex;
    align-items: center;
    gap: var(--space-2);
}

[data-testid="stSidebar"] .stPageLink a,
[data-testid="stSidebar"] .stPageLink span,
[data-testid="stSidebar"] .stPageLink p,
[data-testid="stSidebar"] a {
    font-family: var(--font) !important;
    color: var(--text-2) !important;
    font-size: 0.9375rem !important;
    font-weight: 400 !important;
    text-decoration: none !important;
}

[data-testid="stSidebar"] .stPageLink > a,
[data-testid="stSidebar"] [data-testid="stPageLink-NavLink"] {
    color: var(--text-2) !important;
    font-size: 0.9375rem !important;
    padding: var(--space-3) var(--space-4) !important;
    border-radius: var(--radius-sm) !important;
    margin-bottom: 2px !important;
    display: flex !important;
    align-items: center !important;
    gap: var(--space-3) !important;
    transition: all 0.15s ease !important;
    border-left: none !important;
    min-height: 44px !important;
}

[data-testid="stSidebar"] .stPageLink > a:hover,
[data-testid="stSidebar"] [data-testid="stPageLink-NavLink"]:hover {
    background: var(--bg-elevated) !important;
    color: var(--text-1) !important;
}

[data-testid="stSidebar"] .stPageLink > a[aria-current="page"],
[data-testid="stSidebar"] [data-testid="stPageLink-NavLink"][aria-current="page"] {
    background: var(--accent-dim) !important;
    color: var(--accent) !important;
    font-weight: 500 !important;
}

/* ===== Page Title ===== */
.page-title {
    font-family: var(--font);
    font-size: 1.625rem;
    font-weight: 700;
    color: var(--text-1);
    margin-bottom: var(--space-1);
    letter-spacing: -0.025em;
    line-height: 1.2;
}

.page-desc {
    font-family: var(--font);
    font-size: 0.875rem;
    color: var(--text-2);
    margin-bottom: var(--space-6);
    font-weight: 400;
    line-height: 1.5;
}

/* ===== Stat Cards ===== */
.stat-card {
    background: var(--bg-surface);
    border-radius: var(--radius-md);
    padding: var(--space-5) var(--space-5);
    border: 1px solid var(--border);
    transition: border-color 0.2s ease;
}

.stat-card:hover {
    border-color: var(--border-accent);
}

.stat-header {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-family: var(--font);
    font-size: 0.75rem;
    color: var(--text-2);
    margin-bottom: var(--space-3);
    font-weight: 500;
    letter-spacing: 0.02em;
    text-transform: uppercase;
}

.stat-icon {
    width: 16px;
    height: 16px;
    opacity: 0.6;
}

.stat-value {
    font-family: var(--font);
    font-size: 1.75rem;
    font-weight: 700;
    color: var(--text-1);
    letter-spacing: -0.03em;
    line-height: 1;
}

.stat-sub {
    font-family: var(--font);
    font-size: 0.6875rem;
    color: var(--text-3);
    margin-top: var(--space-2);
    font-weight: 400;
}

/* ===== Buttons ===== */
.action-btn-primary {
    background: var(--accent);
    color: #000;
    border: none;
    border-radius: var(--radius-sm);
    padding: 14px var(--space-5);
    font-family: var(--font);
    font-size: 0.9375rem;
    font-weight: 600;
    width: 100%;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: var(--space-2);
    margin-bottom: var(--space-3);
    transition: all 0.15s ease;
    min-height: 48px;
}

.action-btn-primary:hover {
    background: var(--accent-soft);
    transform: translateY(-1px);
}

.action-btn-secondary {
    background: var(--bg-surface);
    color: var(--text-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 14px var(--space-5);
    font-family: var(--font);
    font-size: 0.9375rem;
    font-weight: 500;
    width: 100%;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: var(--space-2);
    margin-bottom: var(--space-3);
    transition: all 0.15s ease;
    min-height: 48px;
}

.action-btn-secondary:hover {
    border-color: var(--border-accent);
    background: var(--bg-elevated);
}

/* ===== Streamlit Button Overrides ===== */
.stButton > button {
    font-family: var(--font) !important;
    border-radius: var(--radius-sm) !important;
    font-weight: 600 !important;
    font-size: 0.9375rem !important;
    transition: all 0.15s ease !important;
    letter-spacing: -0.01em !important;
    min-height: 48px !important;
    padding: 10px var(--space-5) !important;
}

.stButton > button[kind="primary"] {
    background: var(--accent) !important;
    border: none !important;
    color: #000 !important;
}

.stButton > button[kind="primary"]:hover {
    background: var(--accent-soft) !important;
}

.stButton > button[kind="secondary"] {
    background: var(--bg-surface) !important;
    border: 1px solid var(--border) !important;
    color: var(--text-1) !important;
}

.stButton > button[kind="secondary"]:hover {
    border-color: var(--border-accent) !important;
    background: var(--bg-elevated) !important;
}

/* ===== Report List Items ===== */
.report-item {
    background: var(--bg-surface);
    border-radius: var(--radius-sm);
    padding: var(--space-4) var(--space-4);
    border: 1px solid var(--border);
    margin-bottom: var(--space-2);
    display: flex;
    align-items: center;
    gap: var(--space-3);
    transition: border-color 0.15s ease;
}

.report-item:hover {
    border-color: var(--border-accent);
}

.report-icon {
    width: 40px;
    height: 40px;
    background: var(--accent-dim);
    border-radius: var(--radius-xs);
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--accent);
    font-size: 1rem;
    flex-shrink: 0;
}

.report-info {
    flex: 1;
    min-width: 0;
}

.report-title {
    font-family: var(--font);
    font-size: 0.9375rem;
    font-weight: 600;
    color: var(--text-1);
    margin-bottom: 2px;
    display: flex;
    align-items: center;
    gap: var(--space-2);
    line-height: 1.3;
}

.report-meta {
    font-family: var(--font);
    font-size: 0.75rem;
    color: var(--text-3);
    display: flex;
    align-items: center;
    gap: var(--space-2);
}

.report-arrow {
    color: var(--text-3);
    font-size: 1.25rem;
    transition: all 0.15s ease;
    flex-shrink: 0;
}

.report-item:hover .report-arrow {
    transform: translateX(3px);
    color: var(--accent);
}

/* ===== Status Badges ===== */
.badge {
    display: inline-flex;
    align-items: center;
    padding: 3px 8px;
    border-radius: var(--radius-xs);
    font-family: var(--font);
    font-size: 0.625rem;
    font-weight: 600;
    letter-spacing: 0.03em;
    text-transform: uppercase;
}

.badge-success { background: var(--green-bg); color: var(--green); }
.badge-warning { background: var(--yellow-bg); color: var(--yellow); }
.badge-danger { background: var(--red-bg); color: var(--red); }
.badge-pending { background: var(--bg-elevated); color: var(--text-3); border: 1px solid var(--border); }

/* ===== Alerts & Notifications ===== */
.stAlert > div {
    color: var(--text-1) !important;
    border-radius: var(--radius-sm) !important;
    background: var(--bg-surface) !important;
    border: 1px solid var(--border) !important;
}
.stAlert [data-testid="stMarkdownContainer"] p {
    color: var(--text-1) !important;
}
div[data-baseweb="notification"] {
    color: var(--text-1) !important;
    border-radius: var(--radius-sm) !important;
    background: var(--bg-surface) !important;
}
div[data-baseweb="notification"] div {
    color: var(--text-1) !important;
}

/* ===== Category Cards ===== */
.category-card {
    background: var(--bg-surface);
    border-radius: var(--radius-md);
    padding: var(--space-5);
    border: 1px solid var(--border);
    margin-bottom: var(--space-4);
}

.category-header {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-family: var(--font);
    font-size: 0.9375rem;
    font-weight: 600;
    color: var(--text-1);
    margin-bottom: var(--space-3);
    letter-spacing: -0.01em;
}

/* ===== Metric Rows ===== */
.metric-row {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    padding: var(--space-3) 0;
    border-bottom: 1px solid var(--border);
}

.metric-row:last-child {
    border-bottom: none;
    padding-bottom: 0;
}

.metric-name {
    font-family: var(--font);
    font-size: 0.875rem;
    font-weight: 500;
    color: var(--text-1);
    margin-bottom: 2px;
}

.metric-benchmark {
    font-family: var(--font);
    font-size: 0.75rem;
    color: var(--text-3);
    line-height: 1.4;
}

.metric-compare-up {
    color: var(--green);
    font-size: 0.75rem;
    font-weight: 600;
}

.metric-compare-down {
    color: var(--red);
    font-size: 0.75rem;
    font-weight: 600;
}

.metric-value {
    font-family: var(--font);
    font-size: 1.0625rem;
    font-weight: 700;
    color: var(--text-1);
    letter-spacing: -0.02em;
}

/* ===== Risk Cards ===== */
.risk-card {
    background: var(--bg-surface);
    border-radius: var(--radius-md);
    padding: var(--space-5);
    text-align: center;
    border: 1px solid var(--border);
}

.risk-label {
    font-family: var(--font);
    font-size: 0.6875rem;
    color: var(--text-2);
    margin-bottom: var(--space-3);
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.04em;
}

.risk-value {
    font-family: var(--font);
    font-size: 2rem;
    font-weight: 700;
    letter-spacing: -0.03em;
    line-height: 1;
}

.risk-value.critical { color: var(--red); }
.risk-value.high { color: var(--yellow); }
.risk-value.medium { color: var(--yellow); }

.risk-sub {
    font-family: var(--font);
    font-size: 0.6875rem;
    color: var(--text-3);
    margin-top: var(--space-2);
}

/* ===== Upload Area ===== */
.upload-area {
    border: 1.5px dashed var(--text-4);
    border-radius: var(--radius-lg);
    padding: var(--space-8) var(--space-6);
    text-align: center;
    background: var(--bg-surface);
    margin: var(--space-4) 0;
    transition: all 0.15s ease;
}

.upload-area:hover {
    border-color: var(--accent);
    background: var(--accent-glow);
}

.upload-icon {
    font-size: 2rem;
    color: var(--text-3);
    margin-bottom: var(--space-3);
}

.upload-text {
    font-family: var(--font);
    font-size: 0.875rem;
    color: var(--text-2);
}

/* ===== Text Input ===== */
.stTextInput > div > div > input {
    font-family: var(--font) !important;
    border-radius: var(--radius-sm) !important;
    border: 1px solid var(--border) !important;
    padding: 14px var(--space-4) !important;
    background: var(--bg-surface) !important;
    color: var(--text-1) !important;
    font-size: 1rem !important;
    transition: all 0.15s ease !important;
    min-height: 48px !important;
}

.stTextInput > div > div > input:focus {
    border-color: var(--accent) !important;
    box-shadow: 0 0 0 3px var(--accent-dim) !important;
}

.stTextInput > div > div > input::placeholder {
    color: var(--text-3) !important;
}

/* ===== Select & MultiSelect ===== */
.stSelectbox > div > div {
    border-radius: var(--radius-sm) !important;
    border-color: var(--border) !important;
    background: var(--bg-surface) !important;
    min-height: 48px !important;
}

.stSelectbox [data-baseweb="select"] > div {
    background: var(--bg-surface) !important;
    border-color: var(--border) !important;
    color: var(--text-1) !important;
}

.stMultiSelect > div > div {
    border-radius: var(--radius-sm) !important;
    border-color: var(--border) !important;
    background: var(--bg-surface) !important;
}

.stMultiSelect [data-baseweb="select"] > div {
    background: var(--bg-surface) !important;
    color: var(--text-1) !important;
}

/* ===== Tabs ===== */
.stTabs [data-baseweb="tab-list"] {
    gap: var(--space-1);
    background: transparent;
    border-radius: 0;
    padding: 0;
    border-bottom: 1px solid var(--border);
}

.stTabs [data-baseweb="tab"] {
    font-family: var(--font);
    padding: var(--space-3) var(--space-4);
    font-size: 0.875rem;
    color: var(--text-3);
    border-radius: var(--radius-xs) var(--radius-xs) 0 0;
    border-bottom: 2px solid transparent;
    margin-bottom: -1px;
    font-weight: 500;
    transition: all 0.15s ease;
}

.stTabs [data-baseweb="tab"]:hover {
    color: var(--text-2);
    background: var(--bg-elevated);
}

.stTabs [aria-selected="true"] {
    color: var(--accent) !important;
    background: transparent !important;
    border-bottom-color: var(--accent) !important;
}

/* ===== Dividers ===== */
hr {
    border: none;
    border-top: 1px solid var(--border);
    margin: var(--space-4) 0;
}

.stAlert {
    border-radius: var(--radius-sm) !important;
}

/* ========== iPhone 17 — Mobile First ========== */
@media (max-width: 430px) {
    /* Dynamic Island top safe area */
    .main .block-container {
        padding: var(--space-4) var(--space-4);
        padding-top: calc(var(--safe-top) + 56px) !important;
        padding-bottom: calc(80px + var(--safe-bottom)) !important;
        max-width: 100% !important;
    }

    .page-title {
        font-size: 1.375rem !important;
        letter-spacing: -0.02em;
    }

    .page-desc {
        font-size: 0.8125rem !important;
        margin-bottom: var(--space-4) !important;
    }

    /* Stat cards — 2-column grid */
    .stat-card {
        padding: var(--space-4) !important;
        border-radius: var(--radius-sm) !important;
    }

    .stat-value {
        font-size: 1.5rem !important;
    }

    .stat-header {
        font-size: 0.6875rem !important;
    }

    .stat-sub {
        font-size: 0.625rem !important;
    }

    /* Report items */
    .report-item {
        padding: var(--space-3) var(--space-4) !important;
        gap: var(--space-3) !important;
        border-radius: var(--radius-sm) !important;
    }

    .report-icon {
        width: 36px !important;
        height: 36px !important;
        font-size: 0.875rem !important;
    }

    .report-title {
        font-size: 0.875rem !important;
    }

    .report-meta {
        font-size: 0.6875rem !important;
    }

    /* Category cards */
    .category-card {
        padding: var(--space-4) !important;
        border-radius: var(--radius-sm) !important;
    }

    .category-header {
        font-size: 0.875rem !important;
    }

    /* Metric cards */
    .metric-card {
        padding: var(--space-4) !important;
        margin-bottom: var(--space-2) !important;
    }

    .metric-label {
        font-size: 0.75rem !important;
    }

    .metric-value {
        font-size: 1.375rem !important;
    }

    /* Risk cards */
    .risk-card {
        padding: var(--space-4) !important;
    }

    .risk-value {
        font-size: 1.5rem !important;
    }

    /* Upload area */
    .upload-area {
        padding: var(--space-6) var(--space-4) !important;
    }

    .upload-icon {
        font-size: 1.75rem !important;
    }

    /* Buttons — 48px min touch target */
    .stButton > button {
        min-height: 48px !important;
        padding: 12px var(--space-4) !important;
        font-size: 0.9375rem !important;
        border-radius: var(--radius-sm) !important;
    }

    div.stButton {
        margin-top: var(--space-2) !important;
    }

    /* Input fields — prevent iOS zoom (font-size >= 16px) */
    .stTextInput input,
    .stTextArea textarea {
        min-height: 48px !important;
        font-size: 16px !important;
        line-height: 1.3 !important;
    }

    [data-testid="stSelectbox"] [data-baseweb="select"] > div,
    [data-testid="stMultiSelect"] [data-baseweb="select"] > div {
        min-height: 48px !important;
        font-size: 16px !important;
    }

    /* Columns stack vertically */
    .main .block-container [data-testid="stHorizontalBlock"] {
        flex-direction: column !important;
        gap: var(--space-3) !important;
    }

    .main .block-container [data-testid="column"] {
        width: 100% !important;
        flex: 1 1 100% !important;
    }

    /* Tabs — horizontal scroll */
    .stTabs [data-baseweb="tab-list"] {
        overflow-x: auto !important;
        overflow-y: hidden !important;
        white-space: nowrap !important;
        scrollbar-width: none;
        -webkit-overflow-scrolling: touch;
    }

    .stTabs [data-baseweb="tab-list"]::-webkit-scrollbar {
        display: none;
    }

    .stTabs [data-baseweb="tab"] {
        padding: var(--space-3) var(--space-3) !important;
        font-size: 0.8125rem !important;
        flex: 0 0 auto !important;
    }

    /* Sidebar */
    [data-testid="stSidebar"] > div:first-child {
        padding: var(--space-4) var(--space-3) !important;
    }

    .sidebar-title {
        font-size: 0.75rem !important;
        margin-bottom: var(--space-4) !important;
    }

    /* Hide Streamlit header */
    header[data-testid="stHeader"] {
        display: none !important;
    }

    /* Typography */
    h1 {
        font-size: 1.375rem !important;
        line-height: 1.2 !important;
        margin-bottom: var(--space-2) !important;
    }
    h2 {
        font-size: 1.125rem !important;
        margin-bottom: var(--space-2) !important;
    }
    h3 {
        font-size: 1rem !important;
    }

    /* Tables */
    .stDataFrame,
    [data-testid="stDataFrame"] {
        overflow-x: auto !important;
        -webkit-overflow-scrolling: touch !important;
    }
    .stDataFrame table,
    [data-testid="stDataFrame"] table {
        font-size: 0.75rem !important;
        min-width: max-content !important;
    }
    .stDataFrame th,
    .stDataFrame td,
    [data-testid="stDataFrame"] th,
    [data-testid="stDataFrame"] td {
        padding: var(--space-2) var(--space-3) !important;
        white-space: nowrap !important;
    }

    /* Expanders */
    .streamlit-expanderHeader {
        font-size: 0.875rem !important;
        padding: var(--space-3) !important;
        min-height: 48px !important;
    }
    .streamlit-expanderContent {
        padding: var(--space-3) !important;
    }

    /* Markdown */
    .stMarkdown p {
        font-size: 0.9375rem !important;
        line-height: 1.6 !important;
    }
    .stMarkdown ul, .stMarkdown ol {
        padding-left: 1.25rem !important;
    }
    .stMarkdown li {
        margin-bottom: var(--space-2) !important;
    }

    /* Alerts */
    .stAlert {
        padding: var(--space-3) !important;
        font-size: 0.875rem !important;
    }

    /* File uploader */
    [data-testid="stFileUploader"] {
        padding: var(--space-4) !important;
    }
    [data-testid="stFileUploader"] section {
        padding: var(--space-5) var(--space-4) !important;
        min-height: 120px !important;
    }

    /* Metric component */
    [data-testid="stMetric"] {
        padding: var(--space-2) !important;
    }
    [data-testid="stMetricValue"] {
        font-size: 1.25rem !important;
    }
    [data-testid="stMetricLabel"] {
        font-size: 0.8125rem !important;
    }

    /* Plotly charts */
    .stPlotlyChart {
        margin: 0 calc(-1 * var(--space-2)) !important;
    }

    /* Progress bar */
    .stProgress > div {
        height: 6px !important;
    }

    /* Code blocks */
    .stCodeBlock {
        font-size: 0.6875rem !important;
    }
    pre {
        font-size: 0.6875rem !important;
        overflow-x: auto !important;
        white-space: pre !important;
    }
}

/* ========== Mobile Navigation Bar ========== */
.mobile-nav-bar {
    display: none;
}

@media (max-width: 430px) {
    .mobile-nav-bar {
        display: flex !important;
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        height: calc(48px + var(--safe-top));
        padding-top: var(--safe-top);
        background: rgba(5, 5, 5, 0.85);
        -webkit-backdrop-filter: saturate(180%) blur(20px);
        backdrop-filter: saturate(180%) blur(20px);
        border-bottom: 0.5px solid var(--border);
        z-index: 999998;
        align-items: center;
        justify-content: center;
        padding-left: var(--space-4);
        padding-right: var(--space-4);
    }

    .mobile-nav-bar .nav-title {
        color: var(--text-1);
        font-size: 0.9375rem;
        font-weight: 600;
        flex: 1;
        text-align: center;
        margin: 0 var(--space-4);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        letter-spacing: -0.01em;
    }

    .mobile-nav-bar .nav-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        min-width: 44px;
        min-height: 44px;
        background: var(--bg-elevated);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        color: var(--text-2);
        font-size: 1.125rem;
        cursor: pointer;
        text-decoration: none;
        transition: all 0.15s;
    }

    .mobile-nav-bar .nav-btn:hover,
    .mobile-nav-bar .nav-btn:active {
        background: var(--accent-dim);
        border-color: var(--border-accent);
        color: var(--accent);
    }

    /* Bottom navigation buttons */
    .mobile-nav-buttons {
        position: fixed;
        bottom: 0;
        left: 0;
        right: 0;
        padding: var(--space-2) var(--space-4);
        padding-bottom: calc(var(--space-2) + var(--safe-bottom));
        z-index: 999999;
        background: rgba(5, 5, 5, 0.9);
        -webkit-backdrop-filter: saturate(180%) blur(20px);
        backdrop-filter: saturate(180%) blur(20px);
        border-top: 0.5px solid var(--border);
        display: flex;
        justify-content: space-around;
        align-items: center;
    }

    .mobile-nav-buttons > div {
        flex: 1;
    }

    .mobile-nav-buttons .stButton > button {
        min-height: 44px !important;
        border-radius: var(--radius-sm) !important;
        font-size: 0.75rem !important;
        padding: var(--space-2) var(--space-2) !important;
        background: transparent !important;
        color: var(--text-2) !important;
        border: none !important;
        box-shadow: none !important;
        font-weight: 500 !important;
        letter-spacing: 0 !important;
        width: 100% !important;
    }

    .mobile-nav-buttons .stButton > button:active {
        background: var(--accent-dim) !important;
        color: var(--accent) !important;
        transform: scale(0.97);
    }

    /* Keep bottom nav buttons horizontal */
    .mobile-nav-buttons [data-testid="stHorizontalBlock"] {
        flex-wrap: nowrap !important;
        gap: var(--space-1) !important;
        flex-direction: row !important;
    }
    .mobile-nav-buttons [data-testid="column"] {
        width: auto !important;
        flex: 1 1 auto !important;
        min-width: 0 !important;
    }

    /* Hide sidebar toggle on mobile (we use nav bar instead) */
    [data-testid="stSidebarCollapsedControl"],
    [data-testid="collapsedControl"] {
        display: none !important;
    }
}

/* Desktop: hide mobile nav */
@media (min-width: 431px) {
    .mobile-bottom-nav,
    .mobile-nav-buttons {
        display: none !important;
    }
}
</style>
"""


def inject_css():
    import streamlit as st
    st.markdown(GLOBAL_CSS, unsafe_allow_html=True)


def render_sidebar():
    import streamlit as st
    st.markdown('<div class="sidebar-title">Financial Expert</div>', unsafe_allow_html=True)


def render_sidebar_nav():
    """Render sidebar navigation"""
    import streamlit as st
    render_sidebar()
    st.page_link("app.py", label="Dashboard", icon="")
    st.page_link("pages/1_股票查询.py", label="Stock Search", icon="")
    st.page_link("pages/2_上传报表.py", label="Upload Report", icon="")
    st.page_link("pages/3_分析报告.py", label="Analysis", icon="")
    st.page_link("pages/4_财务指标.py", label="Metrics", icon="")
    st.page_link("pages/5_风险预警.py", label="Risk Alerts", icon="")
    st.page_link("pages/6_趋势分析.py", label="Trends", icon="")


def render_mobile_nav(title: str = "Financial Expert", show_back: bool = True, back_url: str = "app.py"):
    """Render iPhone 17 optimized navigation bar with safe area support"""
    import streamlit as st

    # Top navigation bar
    st.markdown(f'''
    <div class="mobile-nav-bar">
        <span class="nav-title">{title}</span>
    </div>
    ''', unsafe_allow_html=True)

    # Bottom tab bar styles
    st.markdown('''
    <style>
    @media (max-width: 430px) {
        .mobile-tab-bar {
            position: fixed;
            bottom: 0;
            left: 0;
            right: 0;
            background: rgba(5, 5, 5, 0.92);
            -webkit-backdrop-filter: saturate(180%) blur(20px);
            backdrop-filter: saturate(180%) blur(20px);
            border-top: 0.5px solid rgba(255,255,255,0.06);
            padding: 6px 0;
            padding-bottom: calc(6px + env(safe-area-inset-bottom, 0px));
            z-index: 999998;
            display: flex;
            justify-content: space-around;
            align-items: center;
        }
        .mobile-tab-bar .tab-item {
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 2px;
            padding: 4px 8px;
            color: var(--text-3);
            text-decoration: none;
            font-size: 0.625rem;
            font-weight: 500;
            border-radius: 8px;
            transition: color 0.15s;
            min-width: 56px;
            letter-spacing: 0.01em;
        }
        .mobile-tab-bar .tab-item.active {
            color: var(--accent);
        }
        .mobile-tab-bar .tab-item .tab-icon {
            font-size: 1.25rem;
            line-height: 1;
        }
    }
    @media (min-width: 431px) {
        .mobile-tab-bar { display: none !important; }
    }
    </style>
    ''', unsafe_allow_html=True)

    # Bottom tab bar
    st.markdown('''
    <div class="mobile-tab-bar">
        <div class="tab-item active"><span class="tab-icon"></span>Home</div>
        <div class="tab-item"><span class="tab-icon"></span>Search</div>
        <div class="tab-item"><span class="tab-icon"></span>Reports</div>
        <div class="tab-item"><span class="tab-icon"></span>Risks</div>
    </div>
    ''', unsafe_allow_html=True)

    # Functional bottom navigation (Streamlit buttons for actual navigation)
    st.markdown('<div class="mobile-nav-buttons">', unsafe_allow_html=True)
    cols = st.columns([1, 1, 1, 1])
    with cols[0]:
        if st.button("", key=f"m_back_{title}"):
            st.switch_page(back_url)
    with cols[1]:
        if st.button("", key=f"m_home_{title}"):
            st.switch_page("app.py")
    with cols[2]:
        if st.button("", key=f"m_search_{title}"):
            st.switch_page("pages/1_股票查询.py")
    with cols[3]:
        if st.button("", key=f"m_report_{title}"):
            st.switch_page("pages/3_分析报告.py")
    st.markdown('</div>', unsafe_allow_html=True)


def stat_card(label: str, value, sub: str = "", icon: str = "") -> str:
    return f'''
    <div class="stat-card">
        <div class="stat-header">
            <span>{icon}</span>
            <span>{label}</span>
        </div>
        <div class="stat-value">{value}</div>
        <div class="stat-sub">{sub}</div>
    </div>
    '''


def badge(text: str, status: str = "pending") -> str:
    return f'<span class="badge badge-{status}">{text}</span>'


def report_item(title: str, meta: str, status: str, status_text: str) -> str:
    return f'''
    <div class="report-item">
        <div class="report-icon"></div>
        <div class="report-info">
            <div class="report-title">{title} {badge(status_text, status)}</div>
            <div class="report-meta">{meta}</div>
        </div>
        <div class="report-arrow">›</div>
    </div>
    '''


def risk_card(label: str, value: int, sub: str, level: str = "medium") -> str:
    return f'''
    <div class="risk-card">
        <div class="risk-label">{label}</div>
        <div class="risk-value {level}">{value}</div>
        <div class="risk-sub">{sub}</div>
    </div>
    '''
