/**
 * HQ Rhythm Engine — 总部主管工作节奏
 * 
 * 09:30 晨检 — 昨日异常Top / 未闭环清单 / 阻塞事项
 * 11:30 巡检 — BI+DataAuditor规则检查+数据质量
 * 16:30 巡检 — 同上
 * 21:30 日终 — 闭环率/逾期率/提醒次数/证据链缺失+明日风险预告
 * 周一10:00 周报
 * 每月1日 月度评估
 */
import cron from 'node-cron';
import { query } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { runAnomalyChecks } from './anomaly-engine.js';

// ─── 获取活跃门店列表 ───
async function getActiveStores() {
  const r = await query(
    `SELECT DISTINCT store FROM daily_reports WHERE date >= CURRENT_DATE - 30 AND store IS NOT NULL`
  );
  return r.rows.map(r => r.store);
}

// ─── 记录节奏执行日志 ───
async function logRhythm(type, status, summary, error = null) {
  try {
    await query(
      `INSERT INTO rhythm_logs (rhythm_type, execution_date, execution_time, status, result_summary, error_message)
       VALUES ($1, CURRENT_DATE, CURRENT_TIME, $2, $3, $4)`,
      [type, status, JSON.stringify(summary), error]
    );
  } catch (e) {
    logger.error({ err: e }, 'Failed to log rhythm');
  }
}

// ─── 09:30 晨检 ───
export async function morningStandup() {
  logger.info('🌅 Running morning standup');
  const stores = await getActiveStores();
  const summary = { stores: stores.length, anomalies: [], pendingTasks: 0, blockers: [] };

  try {
    // 1. 昨日新增异常 Top
    const newAnomalies = await query(
      `SELECT anomaly_key, store, severity, trigger_value
       FROM anomaly_triggers
       WHERE trigger_date = CURRENT_DATE - 1
       ORDER BY CASE severity WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END
       LIMIT 10`
    );
    summary.anomalies = newAnomalies.rows;

    // 2. 未闭环清单（按逾期排序）
    const pendingTasks = await query(
      `SELECT task_id, title, store, severity, status, created_at, timeout_at,
              EXTRACT(EPOCH FROM (now() - created_at))/3600 AS hours_open
       FROM master_tasks
       WHERE status NOT IN ('closed', 'settled')
       ORDER BY
         CASE WHEN timeout_at < now() THEN 0 ELSE 1 END,
         CASE severity WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
         created_at ASC
       LIMIT 20`
    );
    summary.pendingTasks = pendingTasks.rows.length;
    summary.taskList = pendingTasks.rows;

    // 3. 阻塞事项（超时未响应）
    const blockers = await query(
      `SELECT task_id, title, store, severity, status
       FROM master_tasks
       WHERE status = 'pending_response'
         AND (timeout_at IS NOT NULL AND timeout_at < now())
       ORDER BY created_at ASC`
    );
    summary.blockers = blockers.rows;

    await logRhythm('morning_standup', 'success', summary);
    logger.info({ pendingTasks: summary.pendingTasks, anomalies: summary.anomalies.length, blockers: summary.blockers.length }, '晨检完成');
    return summary;
  } catch (err) {
    logger.error({ err }, 'Morning standup failed');
    await logRhythm('morning_standup', 'error', {}, err.message);
    throw err;
  }
}

// ─── 11:30 / 16:30 巡检 ───
export async function patrol(waveLabel = 'am') {
  logger.info({ wave: waveLabel }, '🔍 Running patrol');
  const stores = await getActiveStores();

  try {
    // 跑日频和周频异常检测
    const dailyResults = await runAnomalyChecks('daily', stores);
    const triggered = dailyResults.filter(r => r.triggered);

    // 红色通道检查
    const redChannel = await checkRedChannel(stores);

    const summary = {
      wave: waveLabel,
      stores: stores.length,
      checksRun: dailyResults.length,
      triggered: triggered.length,
      triggeredDetails: triggered,
      redChannelAlerts: redChannel
    };

    await logRhythm(`patrol_${waveLabel}`, 'success', summary);
    logger.info({ triggered: triggered.length, redChannel: redChannel.length }, `巡检(${waveLabel})完成`);
    return summary;
  } catch (err) {
    logger.error({ err }, `Patrol ${waveLabel} failed`);
    await logRhythm(`patrol_${waveLabel}`, 'error', {}, err.message);
    throw err;
  }
}

// ─── 红色通道检查 ───
async function checkRedChannel(stores) {
  const alerts = [];

  // 1. high + 24h未响应
  const highNoResponse = await query(
    `SELECT task_id, title, store, severity, created_at
     FROM master_tasks
     WHERE severity = 'high'
       AND status IN ('pending_audit', 'pending_dispatch', 'pending_response')
       AND created_at < now() - INTERVAL '24 hours'`
  );
  for (const t of highNoResponse.rows) {
    alerts.push({ type: 'high_no_response_24h', task: t });
  }

  // 2. 连续3天关键指标异常
  for (const store of stores) {
    const consecutive = await query(
      `SELECT anomaly_key, COUNT(DISTINCT trigger_date) AS days
       FROM anomaly_triggers
       WHERE store = $1 AND trigger_date >= CURRENT_DATE - 3
         AND anomaly_key IN ('revenue_achievement', 'labor_efficiency', 'gross_margin')
       GROUP BY anomaly_key
       HAVING COUNT(DISTINCT trigger_date) >= 3`,
      [store]
    );
    for (const r of consecutive.rows) {
      alerts.push({ type: 'consecutive_3day', store, anomaly: r.anomaly_key, days: r.days });
    }
  }

  // 3. 食品安全（任何未结案的food_safety触发记录）
  const foodSafety = await query(
    `SELECT * FROM anomaly_triggers
     WHERE anomaly_key = 'food_safety' AND status = 'open'
     ORDER BY created_at DESC LIMIT 5`
  );
  for (const t of foodSafety.rows) {
    alerts.push({ type: 'food_safety_open', trigger: t });
  }

  if (alerts.length > 0) {
    logger.error({ count: alerts.length }, '🚨 RED CHANNEL ALERTS');
  }
  return alerts;
}

// ─── 21:30 日终 ───
export async function endOfDay() {
  logger.info('🌙 Running end-of-day summary');

  try {
    // 闭环率
    const total = await query(`SELECT COUNT(*) AS cnt FROM master_tasks WHERE created_at >= CURRENT_DATE`);
    const closed = await query(`SELECT COUNT(*) AS cnt FROM master_tasks WHERE closed_at >= CURRENT_DATE`);
    const overdue = await query(`SELECT COUNT(*) AS cnt FROM master_tasks WHERE timeout_at < now() AND status NOT IN ('closed','settled')`);

    const totalCnt = parseInt(total.rows[0]?.cnt || 0);
    const closedCnt = parseInt(closed.rows[0]?.cnt || 0);
    const overdueCnt = parseInt(overdue.rows[0]?.cnt || 0);
    const closeRate = totalCnt ? ((closedCnt / totalCnt) * 100).toFixed(1) : '0.0';

    // 证据链缺失
    const noEvidence = await query(
      `SELECT COUNT(*) AS cnt FROM master_tasks
       WHERE status NOT IN ('closed','settled')
         AND (evidence_refs IS NULL OR evidence_refs = '[]'::jsonb)`
    );

    // 明日风险预告
    const tomorrowRisk = await query(
      `SELECT store, anomaly_key, severity, trigger_date
       FROM anomaly_triggers
       WHERE status = 'open' AND severity = 'high'
       ORDER BY created_at DESC LIMIT 10`
    );

    const summary = {
      closeRate,
      totalTasks: totalCnt,
      closedToday: closedCnt,
      overdueTasks: overdueCnt,
      noEvidenceTasks: parseInt(noEvidence.rows[0]?.cnt || 0),
      tomorrowRisks: tomorrowRisk.rows
    };

    await logRhythm('end_of_day', 'success', summary);
    logger.info(summary, '日终对账完成');
    return summary;
  } catch (err) {
    logger.error({ err }, 'End of day failed');
    await logRhythm('end_of_day', 'error', {}, err.message);
    throw err;
  }
}

// ─── 周报生成 ───
export async function weeklyReport() {
  logger.info('📊 Generating weekly report');
  const stores = await getActiveStores();

  // 运行周频异常检测
  const weeklyResults = await runAnomalyChecks('weekly', stores);
  const triggered = weeklyResults.filter(r => r.triggered);

  // KPI汇总
  const kpiR = await query(
    `SELECT store,
            AVG(ttfr_p90_minutes) AS avg_ttfr,
            AVG(ttc_p90_hours) AS avg_ttc,
            AVG(timeout_rate) AS avg_timeout,
            AVG(first_pass_rate) AS avg_pass_rate,
            SUM(total_tasks) AS total_tasks,
            SUM(closed_tasks) AS closed_tasks
     FROM kpi_snapshots
     WHERE snapshot_date >= CURRENT_DATE - 7
     GROUP BY store`
  );

  // Top3问题门店
  const top3 = await query(
    `SELECT store, COUNT(*) AS anomaly_count
     FROM anomaly_triggers
     WHERE trigger_date >= CURRENT_DATE - 7 AND severity IN ('high','medium')
     GROUP BY store ORDER BY anomaly_count DESC LIMIT 3`
  );

  const summary = {
    weeklyChecks: weeklyResults.length,
    triggered: triggered.length,
    triggeredDetails: triggered,
    kpiByStore: kpiR.rows,
    top3ProblemStores: top3.rows
  };

  await logRhythm('weekly_report', 'success', summary);
  logger.info({ triggered: triggered.length }, '周报生成完成');
  return summary;
}

// ─── 月度评估 ───
export async function monthlyEvaluation() {
  logger.info('📈 Running monthly evaluation');
  const stores = await getActiveStores();

  // 运行月频检测
  const monthlyResults = await runAnomalyChecks('monthly', stores);

  // 月度KPI汇总
  const kpiR = await query(
    `SELECT store,
            AVG(ttfr_p90_minutes) AS avg_ttfr,
            AVG(ttc_p90_hours) AS avg_ttc,
            AVG(timeout_rate) AS avg_timeout,
            AVG(false_positive_rate) AS avg_fp,
            AVG(evidence_coverage_rate) AS avg_evidence,
            AVG(first_pass_rate) AS avg_pass_rate,
            SUM(total_tasks) AS total_tasks,
            SUM(closed_tasks) AS closed_tasks,
            SUM(overdue_tasks) AS overdue_tasks
     FROM kpi_snapshots
     WHERE snapshot_date >= CURRENT_DATE - 30
     GROUP BY store`
  );

  const summary = {
    monthlyChecks: monthlyResults.length,
    triggered: monthlyResults.filter(r => r.triggered).length,
    kpiByStore: kpiR.rows
  };

  await logRhythm('monthly_evaluation', 'success', summary);
  logger.info(summary, '月度评估完成');
  return summary;
}

// ─── 启动Cron调度 ───
export function startRhythmScheduler() {
  // 09:30 晨检 (Asia/Shanghai)
  cron.schedule('30 9 * * *', async () => {
    try { await morningStandup(); } catch (e) { logger.error({ err: e }, 'Cron: morning standup failed'); }
  }, { timezone: 'Asia/Shanghai' });

  // 11:30 巡检
  cron.schedule('30 11 * * *', async () => {
    try { await patrol('am'); } catch (e) { logger.error({ err: e }, 'Cron: AM patrol failed'); }
  }, { timezone: 'Asia/Shanghai' });

  // 16:30 巡检
  cron.schedule('30 16 * * *', async () => {
    try { await patrol('pm'); } catch (e) { logger.error({ err: e }, 'Cron: PM patrol failed'); }
  }, { timezone: 'Asia/Shanghai' });

  // 21:30 日终
  cron.schedule('30 21 * * *', async () => {
    try { await endOfDay(); } catch (e) { logger.error({ err: e }, 'Cron: end of day failed'); }
  }, { timezone: 'Asia/Shanghai' });

  // 周一 10:00 周报
  cron.schedule('0 10 * * 1', async () => {
    try { await weeklyReport(); } catch (e) { logger.error({ err: e }, 'Cron: weekly report failed'); }
  }, { timezone: 'Asia/Shanghai' });

  // 每月1日 10:00 月度评估
  cron.schedule('0 10 1 * *', async () => {
    try { await monthlyEvaluation(); } catch (e) { logger.error({ err: e }, 'Cron: monthly evaluation failed'); }
  }, { timezone: 'Asia/Shanghai' });

  logger.info('✅ HQ Rhythm Scheduler started (晨检09:30 / 巡检11:30+16:30 / 日终21:30 / 周报周一10:00 / 月评每月1日)');
}
