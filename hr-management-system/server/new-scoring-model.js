/**
 * 新评分模型
 * 包含门店评级和员工评分
 */

import { pool } from './utils/database.js';
import { inferBrandFromStoreName } from './agents.js';
import { safeExecute, safeErrorLog } from './utils/error-handler.js';

// ─────────────────────────────────────────────
// 1. 门店评级模型配置
// ─────────────────────────────────────────────
export const STORE_RATING_CONFIG = {
  name: '门店评级模型',
  type: 'store_rating',
  period: 'monthly', // 按月评级
  rules: {
    'A': { min_rate: 95.01, description: '达成率>95%' },
    'B': { min_rate: 90.01, max_rate: 95.00, description: '达成率>90%' },
    'C': { max_rate: 90.00, description: '其他情况' }
  },
  data_sources: {
    actual_revenue: 'daily_reports',
    target_revenue: 'revenue_targets'
  },
  new_store_grace_period: 1 // 第一个月不评级
};

// ─────────────────────────────────────────────
// 2. 员工评分模型配置
// ─────────────────────────────────────────────
export const EMPLOYEE_SCORE_CONFIG = {
  name: '员工评分模型',
  type: 'employee_score',
  period: 'monthly', // 按月评分
  base_score: 100,
  scoring: {
    base_score: 100,
    exception_bonus: '零异常加分',
    exception_deduction: '异常扣分'
  },
  execution_rules: {
    store_production_manager: {
      data_sources: ['收档检查', '开档检查', '原料收货日报'],
      expected_frequency: 'daily',
      rating_thresholds: {
        'A': { max_missing: 6 }, // 7次以下 (30天*3项=90次，允许缺84次)
        'B': { max_missing: 13 }, // 14次以下
        'C': { max_missing: 20 }, // 21次以下
        'D': { min_missing: 21 }  // 21次及以上
      }
    },
    store_manager: {
      data_sources: ['门店例会报告'],
      expected_frequency: 'daily',
      score_threshold: 7,
      rating_thresholds: {
        'A': { max_missing: 2, max_low_score: 2 },
        'B': { max_missing: 4, max_low_score: 4 },
        'C': { max_missing: 6, max_low_score: 6 },
        'D': { default: true }
      }
    }
  },
  attitude_rules: {
    data_source: 'master_tasks',
    reminder_count: 3,
    rating_thresholds: {
      'A': { max_incomplete: 2 },
      'B': { max_incomplete: 4 },
      'C': { default: true }
    }
  },
  ability_rules: {
    store_production_manager: {
      data_source: 'monthly_margins',
      rating_thresholds: {
        'A': { min_diff: 1.01 },    // 实际>目标+1%
        'B': { min_diff: 0.99, max_diff: 1.01 }, // 目标±1%
        'C': { min_diff: -1.00, max_diff: 0.99 }, // 低于目标1%以上
        'D': { max_diff: -1.00 }    // 低于目标2%及以上
      }
    },
    store_manager: {
      data_source: 'daily_reports',
      rating_thresholds: {
        '洪潮': {
          'A': { min_rating: 4.6 },
          'B': { min_rating: 4.5, max_rating: 4.6 },
          'C': { min_rating: 4.3, max_rating: 4.5 },
          'D': { max_rating: 4.3 }
        },
        '马己仙': {
          'A': { min_rating: 4.5 },
          'B': { min_rating: 4.4, max_rating: 4.5 },
          'C': { min_rating: 4.0, max_rating: 4.4 },
          'D': { max_rating: 4.0 }
        }
      }
    }
  }
};

// ─────────────────────────────────────────────
// 3. 门店评级计算函数
// ─────────────────────────────────────────────
export async function calculateStoreRating(store, brand, period) {
  try {
    // 1. 检查是否为新门店（第一个月不评级）
    const isNewStore = await checkIfNewStore(store, period);
    if (isNewStore) return { rating: null, reason: '新门店第一个月不评级' };
    
    // 2. 获取实际营业额（从daily_reports汇总）
    const actualRevenue = await getMonthlyActualRevenue(store, period);
    
    // 3. 获取目标营业额（从revenue_targets）
    const targetRevenue = await getMonthlyTargetRevenue(store, period);
    
    if (!targetRevenue || targetRevenue <= 0) {
      return { rating: null, reason: '目标营业额未设置或为0' };
    }
    
    // 4. 计算达成率
    const achievementRate = Number((actualRevenue / targetRevenue * 100).toFixed(2));
    
    // 5. 确定评级
    let rating = 'C';
    if (achievementRate > 95) rating = 'A';
    else if (achievementRate > 90) rating = 'B';
    
    // 6. 保存结果
    await saveStoreRating(store, brand, period, actualRevenue, targetRevenue, achievementRate, rating);
    
    return { rating, achievementRate, actualRevenue, targetRevenue };
    
  } catch (error) {
    console.error('[store_rating] 计算失败:', error);
    return { rating: null, reason: error.message };
  }
}

// ─────────────────────────────────────────────
// 4. 员工评分计算函数
// ─────────────────────────────────────────────
export async function calculateEmployeeScore(store, username, role, period) {
  try {
    // 1. 基础得分计算
    const baseScore = 100;
    const exceptionBonus = await calculateExceptionBonus(username, period);
    const exceptionDeduction = await calculateExceptionDeduction(username, period);
    const totalScore = Math.max(0, baseScore + exceptionBonus - exceptionDeduction);
    
    // 2. 执行力评级（数据不足时返回NULL）
    let executionRating = null;
    try {
      executionRating = await calculateExecutionRating(store, username, role, period);
    } catch (e) { console.warn('[employee_score] execution rating error:', e?.message); }
    
    // 3. 工作态度评级（数据不足时返回NULL）
    let attitudeRating = null;
    try {
      attitudeRating = await calculateAttitudeRating(username, period);
    } catch (e) { console.warn('[employee_score] attitude rating error:', e?.message); }
    
    // 4. 工作能力评级（数据不足时返回NULL）
    let abilityRating = null;
    try {
      abilityRating = await calculateAbilityRating(store, username, role, period);
    } catch (e) { console.warn('[employee_score] ability rating error:', e?.message); }
    
    // 5. 保存结果
    try {
      await saveEmployeeScore(store, username, role, period, {
        base_score: baseScore,
        exception_bonus: exceptionBonus,
        exception_deduction: exceptionDeduction,
        total_score: totalScore,
        execution_rating: executionRating,
        attitude_rating: attitudeRating,
        ability_rating: abilityRating
      });
    } catch (e) { console.warn('[employee_score] save error:', e?.message); }
    
    return {
      total_score: totalScore,
      execution_rating: executionRating,
      attitude_rating: attitudeRating,
      ability_rating: abilityRating
    };
    
  } catch (error) {
    console.error('[employee_score] 计算失败:', error);
    // 返回NULL评级表示数据不足
    return {
      total_score: 100,
      execution_rating: null,
      attitude_rating: null,
      ability_rating: null
    };
  }
}

// ─────────────────────────────────────────────
// 5. 执行力评级计算
// ─────────────────────────────────────────────
export async function calculateExecutionRating(store, username, role, period) {
  try {
    if (role === 'store_production_manager') {
      // 出品经理：检查3种申报报表的提交情况
      const openingReports = await getKitchenReportsCount(store, period, 'opening');
      const closingReports = await getKitchenReportsCount(store, period, 'closing');
      const receivingReports = await getMaterialReceivingReportsCount(store, period);
      
      const expectedDays = getDaysInPeriod(period); // 30天或31天
      const totalExpected = expectedDays * 3; // 每天3种报告
      const totalSubmitted = openingReports + closingReports + receivingReports;
      const totalMissing = totalExpected - totalSubmitted;
      
      // 根据缺提交次数确定评级
      if (totalMissing <= 6) return 'A';
      else if (totalMissing <= 13) return 'B';
      else if (totalMissing <= 20) return 'C';
      else return 'D';
    }
    
    if (role === 'store_manager') {
      // 店长：检查门店例会报告的提交情况和得分
      const meetingReports = await getStoreMeetingReports(store, period);
      const totalMissing = meetingReports.filter(r => !r.submitted).length;
      const lowScoreCount = meetingReports.filter(r => r.meeting_score < 7).length;
      
      // 根据缺失次数和低分次数确定评级
      if (totalMissing <= 2 && lowScoreCount <= 2) return 'A';
      else if (totalMissing <= 4 && lowScoreCount <= 4) return 'B';
      else if (totalMissing <= 6 && lowScoreCount <= 6) return 'C';
      else return 'D';
    }
    
    return 'C'; // 默认评级
    
  } catch (error) {
    console.error('[execution_rating] 计算失败:', error);
    return 'C';
  }
}

// ─────────────────────────────────────────────
// 6. 工作态度评级计算
// ─────────────────────────────────────────────
export async function calculateAttitudeRating(username, period) {
  try {
    // 获取该用户在period期间未完成的agent任务次数
    const incompleteCount = await getIncompleteTaskCount(username, period);
    
    // 根据未完成任务次数确定评级
    if (incompleteCount <= 2) return 'A';
    else if (incompleteCount <= 4) return 'B';
    else return 'C';
    
  } catch (error) {
    console.error('[attitude_rating] 计算失败:', error);
    return 'C';
  }
}

// ─────────────────────────────────────────────
// 7. 工作能力评级计算
// ─────────────────────────────────────────────
export async function calculateAbilityRating(store, username, role, period) {
  try {
    if (role === 'store_production_manager') {
      // 出品经理：基于毛利率
      const marginData = await getMarginData(store, period);
      if (!marginData.actual_margin || !marginData.target_margin) {
        return 'C'; // 默认评级
      }
      
      const diff = marginData.actual_margin - marginData.target_margin;
      
      if (diff > 1) return 'A';
      else if (diff >= -1 && diff <= 1) return 'B';
      else if (diff >= -2 && diff < -1) return 'C';
      else return 'D';
    }
    
    if (role === 'store_manager') {
      // 店长：基于大众点评星级
      const rating = await getMonthlyDianpingRating(store, period);
      const brand = inferBrandFromStoreName(store);
      
      if (!rating) return 'C';
      
      const rules = EMPLOYEE_SCORE_CONFIG.ability_rules.store_manager.rating_thresholds[brand];
      if (!rules) return 'C';
      
      if (rating >= rules.A.min_rating) return 'A';
      else if (rating >= rules.B.min_rating) return 'B';
      else if (rating >= rules.C.min_rating) return 'C';
      else return 'D';
    }
    
    return 'C'; // 默认评级
    
  } catch (error) {
    console.error('[ability_rating] 计算失败:', error);
    return 'C';
  }
}

// ─────────────────────────────────────────────
// 8. 辅助函数
// ─────────────────────────────────────────────

// 检查是否为新门店
async function checkIfNewStore(store, period) {
  const result = await pool().query(`
    SELECT COUNT(*) as count FROM store_ratings 
    WHERE store = $1 AND period < $2
  `, [store, period]);
  
  return Number(result.rows[0]?.count || 0) === 0;
}

// 获取月度实际营业额
async function getMonthlyActualRevenue(store, period) {
  const [year, month] = period.split('-');
  const startDate = `${year}-${month}-01`;
  const endDate = `${year}-${month}-31`;
  
  const result = await pool().query(`
    SELECT COALESCE(SUM(revenue), 0) as total_revenue
    FROM daily_reports 
    WHERE store = $1 AND date >= $2 AND date <= $3
  `, [store, startDate, endDate]);
  
  return Number(result.rows[0]?.total_revenue || 0);
}

// 获取月度目标营业额
async function getMonthlyTargetRevenue(store, period) {
  const result = await pool().query(`
    SELECT target_revenue FROM revenue_targets 
    WHERE store = $1 AND period = $2
  `, [store, period]);
  
  return Number(result.rows[0]?.target_revenue || 0);
}

// 保存门店评级
async function saveStoreRating(store, brand, period, actualRevenue, targetRevenue, achievementRate, rating) {
  await pool().query(`
    INSERT INTO store_ratings 
    (store, brand, period, actual_revenue, target_revenue, achievement_rate, rating)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (store, brand, period)
    DO UPDATE SET 
      actual_revenue = EXCLUDED.actual_revenue,
      target_revenue = EXCLUDED.target_revenue,
      achievement_rate = EXCLUDED.achievement_rate,
      rating = EXCLUDED.rating
  `, [store, brand, period, actualRevenue, targetRevenue, achievementRate, rating]);
}

// 保存员工评分
async function saveEmployeeScore(store, username, role, period, scoreData) {
  await pool().query(`
    INSERT INTO employee_scores 
    (store, brand, username, name, role, period, base_score, exception_bonus, exception_deduction, 
     total_score, execution_rating, attitude_rating, ability_rating, execution_data, attitude_data, ability_data)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
    ON CONFLICT (store, username, role, period)
    DO UPDATE SET 
      base_score = EXCLUDED.base_score,
      exception_bonus = EXCLUDED.exception_bonus,
      exception_deduction = EXCLUDED.exception_deduction,
      total_score = EXCLUDED.total_score,
      execution_rating = EXCLUDED.execution_rating,
      attitude_rating = EXCLUDED.attitude_rating,
      ability_rating = EXCLUDED.ability_rating,
      execution_data = EXCLUDED.execution_data,
      attitude_data = EXCLUDED.attitude_data,
      ability_data = EXCLUDED.ability_data,
      updated_at = NOW()
  `, [
    store, inferBrandFromStoreName(store), username, null, role, period,
    scoreData.base_score, scoreData.exception_bonus, scoreData.exception_deduction,
    scoreData.total_score, scoreData.execution_rating, scoreData.attitude_rating, scoreData.ability_rating,
    JSON.stringify(scoreData.execution_data || {}), JSON.stringify(scoreData.attitude_data || {}), JSON.stringify(scoreData.ability_data || {})
  ]);
}

// 获取厨房报告数量
async function getKitchenReportsCount(store, period, reportType) {
  const [year, month] = period.split('-');
  const startDate = `${year}-${month}-01`;
  const endDate = `${year}-${month}-31`;
  
  const result = await pool().query(`
    SELECT COUNT(*) as count FROM kitchen_reports 
    WHERE store = $1 AND report_date >= $2 AND report_date <= $3 AND report_type = $4
  `, [store, startDate, endDate, reportType]);
  
  return Number(result.rows[0]?.count || 0);
}

// 获取原料收货报告数量
async function getMaterialReceivingReportsCount(store, period) {
  const [year, month] = period.split('-');
  const startDate = `${year}-${month}-01`;
  const endDate = `${year}-${month}-31`;
  
  const result = await pool().query(`
    SELECT COUNT(*) as count FROM material_receiving_reports 
    WHERE store = $1 AND report_date >= $2 AND report_date <= $3
  `, [store, startDate, endDate]);
  
  return Number(result.rows[0]?.count || 0);
}

// 获取门店例会报告
async function getStoreMeetingReports(store, period) {
  const [year, month] = period.split('-');
  const startDate = `${year}-${month}-01`;
  const endDate = `${year}-${month}-31`;
  
  const result = await pool().query(`
    SELECT submitted, meeting_score FROM store_meeting_reports 
    WHERE store = $1 AND meeting_date >= $2 AND meeting_date <= $3
  `, [store, startDate, endDate]);
  
  return result.rows;
}

// 获取未完成任务数量
async function getIncompleteTaskCount(username, period) {
  const [year, month] = period.split('-');
  const startDate = `${year}-${month}-01`;
  const endDate = `${year}-${month}-31`;
  
  // 这里需要根据实际的master_tasks表结构来查询
  // 暂时返回0，需要根据实际情况调整
  return 0;
}

// 获取毛利率数据
async function getMarginData(store, period) {
  const result = await pool().query(`
    SELECT actual_margin, target_margin 
    FROM monthly_margins m
    LEFT JOIN margin_targets t ON m.store = t.store AND m.period = t.period
    WHERE m.store = $1 AND m.period = $2
  `, [store, period]);
  
  return result.rows[0] || { actual_margin: null, target_margin: null };
}

// 获取大众点评星级
async function getMonthlyDianpingRating(store, period) {
  const [year, month] = period.split('-');
  // 获取该月最后一天
  const lastDay = new Date(year, month, 0).getDate();
  const lastDate = `${year}-${month}-${lastDay.toString().padStart(2, '0')}`;
  
  const result = await pool().query(`
    SELECT dianping_rating FROM daily_reports 
    WHERE store = $1 AND date = $2 AND dianping_rating IS NOT NULL
    LIMIT 1
  `, [store, lastDate]);
  
  return Number(result.rows[0]?.dianping_rating) || null;
}

// 获取时间段天数
function getDaysInPeriod(period) {
  const [year, month] = period.split('-');
  return new Date(year, month, 0).getDate();
}

// 计算零异常加分
async function calculateExceptionBonus(username, period) {
  // 检查该用户在period期间是否有异常
  const result = await pool().query(`
    SELECT COUNT(*) as count FROM agent_issues 
    WHERE assignee_username = $1 AND created_at >= $2 AND created_at <= $3
  `, [username, `${period}-01`, `${period}-31`]);
  
  const exceptionCount = Number(result.rows[0]?.count || 0);
  return exceptionCount === 0 ? 10 : 0; // 零异常加10分
}

// 计算异常扣分
async function calculateExceptionDeduction(username, period) {
  // 根据异常数量和严重程度计算扣分
  const result = await pool().query(`
    SELECT severity, COUNT(*) as count FROM agent_issues 
    WHERE assignee_username = $1 AND created_at >= $2 AND created_at <= $3
    GROUP BY severity
  `, [username, `${period}-01`, `${period}-31`]);
  
  let totalDeduction = 0;
  for (const row of result.rows) {
    if (row.severity === 'high') totalDeduction += row.count * 5;
    else if (row.severity === 'medium') totalDeduction += row.count * 3;
    else if (row.severity === 'low') totalDeduction += row.count * 1;
  }
  
  return totalDeduction;
}
