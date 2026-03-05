import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cron from 'node-cron';
import { logger } from './utils/logger.js';
import { checkDbHealth } from './utils/db.js';
import { checkRedisHealth } from './utils/queue.js';
import { authRequired, requireRole } from './middleware/auth.js';
import { startRhythmScheduler, morningStandup, patrol, endOfDay, weeklyReport, monthlyEvaluation } from './services/rhythm-engine.js';
import { runAnomalyChecks, checkFoodSafetyFromMessage } from './services/anomaly-engine.js';
import { calculateAllStoresKPI } from './services/kpi-calculator.js';
import { ANOMALY_RULES, ESCALATION_CONFIG, SLA_CONFIG, PUSH_CONFIG, AUTO_DECISION_BOUNDARY } from './config/anomaly-rules.js';

const app = express();
const PORT = parseInt(process.env.PORT || '3100');

app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '5mb' }));

// ─── Health Check ───
app.get('/health', async (req, res) => {
  const db = await checkDbHealth();
  const redis = await checkRedisHealth();
  res.json({
    ok: db,
    service: 'agents-service-v2',
    version: '1.0.0',
    database: db,
    redis,
    uptime: process.uptime(),
    now: new Date().toISOString()
  });
});

// ─── Config API (前台设置中心读取) ───
app.get('/api/config/anomaly-rules', authRequired, (req, res) => {
  res.json({ rules: ANOMALY_RULES });
});

app.get('/api/config/escalation', authRequired, (req, res) => {
  res.json(ESCALATION_CONFIG);
});

app.get('/api/config/sla', authRequired, (req, res) => {
  res.json(SLA_CONFIG);
});

app.get('/api/config/push', authRequired, (req, res) => {
  res.json(PUSH_CONFIG);
});

app.get('/api/config/auto-decision', authRequired, (req, res) => {
  res.json(AUTO_DECISION_BOUNDARY);
});

// ─── Anomaly API ───
app.post('/api/anomaly/run', authRequired, requireRole('admin', 'hq_manager'), async (req, res) => {
  try {
    const { frequency = 'daily', stores } = req.body;
    const storeList = stores || await getActiveStores();
    const results = await runAnomalyChecks(frequency, storeList);
    res.json({ ok: true, results });
  } catch (e) {
    logger.error({ err: e }, 'Manual anomaly run failed');
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/anomaly/food-safety-check', authRequired, async (req, res) => {
  try {
    const { store, content } = req.body;
    const result = await checkFoodSafetyFromMessage(store, content);
    res.json({ ok: true, result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/anomaly/triggers', authRequired, async (req, res) => {
  try {
    const { store, status, severity, limit = 50 } = req.query;
    let sql = `SELECT * FROM anomaly_triggers WHERE 1=1`;
    const params = [];
    if (store) { params.push(store); sql += ` AND store = $${params.length}`; }
    if (status) { params.push(status); sql += ` AND status = $${params.length}`; }
    if (severity) { params.push(severity); sql += ` AND severity = $${params.length}`; }
    params.push(parseInt(limit));
    sql += ` ORDER BY created_at DESC LIMIT $${params.length}`;
    const { query: dbQuery } = await import('./utils/db.js');
    const r = await dbQuery(sql, params);
    res.json({ triggers: r.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Rhythm API (手动触发节奏) ───
app.post('/api/rhythm/morning', authRequired, requireRole('admin', 'hq_manager'), async (req, res) => {
  try {
    const result = await morningStandup();
    res.json({ ok: true, result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/rhythm/patrol', authRequired, requireRole('admin', 'hq_manager'), async (req, res) => {
  try {
    const result = await patrol(req.body?.wave || 'manual');
    res.json({ ok: true, result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/rhythm/end-of-day', authRequired, requireRole('admin', 'hq_manager'), async (req, res) => {
  try {
    const result = await endOfDay();
    res.json({ ok: true, result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/rhythm/weekly', authRequired, requireRole('admin', 'hq_manager'), async (req, res) => {
  try {
    const result = await weeklyReport();
    res.json({ ok: true, result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/rhythm/monthly', authRequired, requireRole('admin', 'hq_manager'), async (req, res) => {
  try {
    const result = await monthlyEvaluation();
    res.json({ ok: true, result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── KPI API ───
app.get('/api/kpi/snapshots', authRequired, async (req, res) => {
  try {
    const { store, days = 7 } = req.query;
    const { query: dbQuery } = await import('./utils/db.js');
    let sql = `SELECT * FROM kpi_snapshots WHERE snapshot_date >= CURRENT_DATE - ($1 || ' days')::interval`;
    const params = [parseInt(days)];
    if (store) { params.push(store); sql += ` AND store = $${params.length}`; }
    sql += ` ORDER BY snapshot_date DESC, store`;
    const r = await dbQuery(sql, params);
    res.json({ snapshots: r.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/kpi/calculate', authRequired, requireRole('admin', 'hq_manager'), async (req, res) => {
  try {
    const results = await calculateAllStoresKPI(req.body?.date || 'yesterday');
    res.json({ ok: true, results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Rhythm Logs API ───
app.get('/api/rhythm/logs', authRequired, async (req, res) => {
  try {
    const { days = 7, type } = req.query;
    const { query: dbQuery } = await import('./utils/db.js');
    let sql = `SELECT * FROM rhythm_logs WHERE execution_date >= CURRENT_DATE - ($1 || ' days')::interval`;
    const params = [parseInt(days)];
    if (type) { params.push(type); sql += ` AND rhythm_type = $${params.length}`; }
    sql += ` ORDER BY created_at DESC LIMIT 100`;
    const r = await dbQuery(sql, params);
    res.json({ logs: r.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Helper ───
async function getActiveStores() {
  const { query: dbQuery } = await import('./utils/db.js');
  const r = await dbQuery(`SELECT DISTINCT store FROM daily_reports WHERE date >= CURRENT_DATE - 30 AND store IS NOT NULL`);
  return r.rows.map(r => r.store);
}

// ─── KPI daily cron (凌晨1:00 计算昨日KPI) ───
function startKpiScheduler() {
  cron.schedule('0 1 * * *', async () => {
    try {
      logger.info('📊 Running daily KPI calculation');
      await calculateAllStoresKPI('yesterday');
    } catch (e) {
      logger.error({ err: e }, 'Daily KPI calculation failed');
    }
  }, { timezone: 'Asia/Shanghai' });
  logger.info('✅ KPI Scheduler started (每日01:00计算)');
}

// ─── Startup ───
async function start() {
  const db = await checkDbHealth();
  if (!db) {
    logger.fatal('Database connection failed, exiting');
    process.exit(1);
  }
  logger.info('✅ Database connected');

  const redis = await checkRedisHealth();
  if (redis) {
    logger.info('✅ Redis connected');
  } else {
    logger.warn('⚠️ Redis not available, queues will not work');
  }

  startRhythmScheduler();
  startKpiScheduler();

  app.listen(PORT, () => {
    logger.info({ port: PORT }, `🚀 agents-service-v2 running on port ${PORT}`);
  });
}

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down...');
  process.exit(0);
});
process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down...');
  process.exit(0);
});

start().catch(err => {
  logger.fatal({ err }, 'Failed to start');
  process.exit(1);
});
