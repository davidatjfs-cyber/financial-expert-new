/**
 * Agent 配置统一管理器
 * 解决配置分散问题，提供统一配置接口
 */

import { 
  UNIFIED_DEDUCTION_RULES, 
  VISUAL_AUDIT_DEDUCTION_RULES, 
  UNIFIED_BRAND_SCORING_MODELS,
  validateScoringConfig
} from './chief-evaluator-config.js';

// ─────────────────────────────────────────────
// 1. Data Auditor 配置
// ─────────────────────────────────────────────
export const DATA_AUDITOR_CONFIG = {
  // 数据源配置
  dataSources: {
    'daily_reports': { 
      source: 'database', 
      table: 'daily_reports',
      pollingInterval: 300000 // 5分钟
    },
    'ops_checklist': { 
      source: 'bitable', 
      config: 'ops_checklist',
      pollingInterval: 60000 // 1分钟
    },
    'table_visit': { 
      source: 'bitable', 
      config: 'table_visit',
      pollingInterval: 300000 // 5分钟
    },
    'negative_reviews': { 
      source: 'database', 
      table: 'negative_reviews',
      pollingInterval: 300000 // 5分钟
    }
  },

  // 异常检测规则（只检测，不评分）
  anomalyDetectionRules: {
    '实收营收异常': { 
      threshold: { high: 0.20, medium: 0.10 },
      dataSource: 'daily_reports',
      calculation: 'revenueGap',
      responsibleRole: 'store_manager'
    },
    '人效值异常': { 
      threshold: { 
        '洪潮': { medium: 1200, high: 1000 },
        '马己仙': { medium: 1300, high: 1300 }
      },
      dataSource: 'daily_reports',
      calculation: 'efficiency',
      responsibleRole: 'store_manager'
    },
    '充值异常': { 
      threshold: { amount: 0, consecutiveDays: 2 },
      dataSource: 'daily_reports',
      calculation: 'rechargeAmount',
      responsibleRole: 'store_manager'
    },
    '桌访异常': { 
      threshold: { high: 4, medium: 2 },
      dataSource: 'table_visit',
      calculation: 'productComplaints',
      responsibleRole: 'store_production_manager'
    },
    '桌访占比异常': { 
      threshold: { high: 0.4, medium: 0.5 },
      dataSource: ['table_visit', 'daily_reports'],
      calculation: 'visitRatio',
      responsibleRole: 'store_manager'
    },
    '总实收毛利率异常': { 
      threshold: { 
        '洪潮': { medium: 0.70, high: 0.69 },
        '马己仙': { medium: 0.65, high: 0.64 }
      },
      dataSource: 'daily_reports',
      calculation: 'marginRate',
      responsibleRole: 'store_production_manager'
    },
    '产品差评异常': { 
      threshold: { high: 3, medium: 1 },
      dataSource: 'negative_reviews',
      calculation: 'productNegativeReviews',
      responsibleRole: 'store_production_manager'
    },
    '服务差评异常': { 
      threshold: { high: 2, medium: 1 },
      dataSource: 'negative_reviews',
      calculation: 'serviceNegativeReviews',
      responsibleRole: 'store_manager'
    }
  },

  // 执行配置
  executionConfig: {
    pollingInterval: 1800000, // 30分钟
    batchSize: 100,
    retryAttempts: 3,
    timeoutMs: 30000
  }
};

// ─────────────────────────────────────────────
// 2. Ops Agent 配置
// ─────────────────────────────────────────────
export const OPS_AGENT_CONFIG = {
  // 任务模板配置
  taskTemplates: {
    '开市检查': {
      '洪潮': [
        '地面清洁无积水',
        '所有设备正常开启',
        '食材新鲜度检查',
        '餐具消毒完成',
        '灯光亮度适中',
        '背景音乐开启',
        '空调温度设置合适',
        '员工仪容仪表检查'
      ],
      '马己仙': [
        '地面清洁',
        '设备开启',
        '食材准备',
        '餐具消毒',
        '迎宾准备'
      ]
    },
    '收档检查': {
      '洪潮': [
        '食材封存',
        '设备关闭',
        '垃圾清理',
        '安全检查',
        '门窗锁好'
      ],
      '马己仙': [
        '食材封存',
        '设备关闭',
        '垃圾清理',
        '安全检查',
        '门窗锁好',
        '电源关闭'
      ]
    },
    '巡检检查': [
      '大厅环境整洁',
      '服务台规范',
      '卫生间清洁',
      '后厨卫生',
      '安全设施'
    ]
  },

  // 定时任务配置
  scheduledTasks: {
    '洪潮_开市': { time: '10:30', action: 'send_checklist', brand: '洪潮', checkType: 'opening' },
    '马己仙_收档': { time: '22:30', action: 'send_checklist', brand: '马己仙', checkType: 'closing' },
    '食安抽检': { random: true, interval: [2, 4], action: 'safety_check' }
  },

  // 图片审核配置（只审核，不扣分）
  imageAuditConfig: {
    supportedTypes: ['hygiene', 'plating', 'general', 'seafood_pool_temperature'],
    antiCheat: {
      enableHashCheck: true,
      enableExifCheck: true,
      enableLocationCheck: false
    },
    qualityThresholds: {
      minConfidence: 0.7,
      minClarity: 0.6
    }
  },

  // 执行配置
  executionConfig: {
    taskTimeout: 3600000, // 1小时
    reminderInterval: 900000, // 15分钟
    maxReminders: 3
  }
};

// ─────────────────────────────────────────────
// 3. Chief Evaluator 配置
// ─────────────────────────────────────────────
export const CHIEF_EVALUATOR_CONFIG = {
  // 评分周期配置
  scoringPeriods: {
    weekly: { 
      type: 'weekly',
      calculationDay: 'Monday',
      calculationTime: '09:00',
      lookbackDays: 7
    },
    monthly: {
      type: 'monthly',
      calculationDay: 1,
      calculationTime: '09:00',
      lookbackDays: 30
    }
  },

  // 评分配置（使用统一配置）
  scoringRules: UNIFIED_DEDUCTION_RULES,
  visualAuditRules: VISUAL_AUDIT_DEDUCTION_RULES,
  brandModels: UNIFIED_BRAND_SCORING_MODELS,

  // 绩效计算配置
  performanceConfig: {
    baseScore: 100,
    maxScore: 200,
    minScore: 0,
    bonusThreshold: 95,
    penaltyThreshold: 60
  },

  // 执行配置
  executionConfig: {
    calculationTimeout: 300000, // 5分钟
    notificationEnabled: true,
    reportGeneration: true
  }
};

// ─────────────────────────────────────────────
// 4. Train Agent 配置（原 SOP Agent，增加培训体系能力）
// ─────────────────────────────────────────────
export const TRAIN_AGENT_CONFIG = {
  // 知识库配置
  knowledgeBaseConfig: {
    defaultLimit: 5,
    maxLimit: 20,
    searchFields: ['title', 'content', 'tags'],
    brandFiltering: true
  },

  // 品牌差异化配置
  brandDifferentiation: {
    '洪潮': {
      sopKeypoints: [
        '传统潮汕菜工艺标准',
        '海鲜食材处理规范',
        '古法烹饪技术要求',
        '传统服务礼仪'
      ],
      trainingFocus: [
        '潮汕菜系传统工艺培训',
        '海鲜食材鉴别与处理技能',
        '古法烹饪师徒带教体系',
        '高端服务礼仪与客户体验'
      ]
    },
    '马己仙': {
      sopKeypoints: [
        '广东小馆出品标准',
        '粤菜基础工艺要求',
        '现代服务流程',
        '成本控制规范'
      ],
      trainingFocus: [
        '粤菜基础技能快速上岗',
        '标准化服务流程培训',
        '成本意识与损耗控制',
        '新员工入职培训体系'
      ]
    }
  },

  // 培训战略与体系配置
  trainingStrategyConfig: {
    // 培训体系框架
    frameworkModules: [
      '人才发展与梯队培养',
      '领导力发展框架',
      '管培生体系',
      '内训师体系',
      '企业文化落地'
    ],
    // 培训需求分析维度
    needsAnalysisDimensions: [
      '岗位能力差距',
      '业务部门反馈',
      '绩效考核短板',
      '新员工入职需求',
      '晋升储备需求'
    ],
    // 核心培训项目类型
    coreProjectTypes: [
      '管理层培训',
      '关键岗位赋能',
      '新员工入职培训',
      '岗位技能培训',
      '食品安全专项培训',
      '服务意识与礼仪培训'
    ],
    // 培训效果评估模型（柯氏四级）
    evaluationLevels: [
      { level: 1, name: '反应层', description: '学员满意度调查' },
      { level: 2, name: '学习层', description: '知识/技能测试' },
      { level: 3, name: '行为层', description: '岗位行为改变跟踪' },
      { level: 4, name: '结果层', description: '业务指标改善/ROI' }
    ]
  },

  // 基础培训执行配置
  trainingExecutionConfig: {
    // 新员工入职培训流程
    onboardingFlow: [
      '公司文化与制度介绍',
      '岗位职责与技能培训',
      '食品安全与卫生规范',
      '服务流程与礼仪标准',
      '实操考核与带教跟岗'
    ],
    // 培训资料类型
    materialTypes: [
      '课件PPT',
      '视频教程',
      'SOP手册',
      '考试题库',
      '案例分析',
      '实操指南'
    ],
    // 培训数据记录字段
    recordFields: [
      'training_id',       // 培训编号
      'training_name',     // 培训名称
      'training_type',     // 培训类型
      'trainer',           // 讲师
      'attendees',         // 参训人员
      'store',             // 门店
      'brand',             // 品牌
      'scheduled_date',    // 计划日期
      'actual_date',       // 实际日期
      'duration_hours',    // 时长
      'status',            // 状态
      'feedback_score',    // 反馈评分
      'materials',         // 培训材料
      'notes'              // 备注
    ]
  },

  // 响应配置
  responseConfig: {
    maxTokens: 800,
    temperature: 0.05,
    responseFormat: 'structured',
    languageStyle: 'professional'
  }
};

// 兼容别名：旧代码可能仍引用 SOP_AGENT_CONFIG
export const SOP_AGENT_CONFIG = TRAIN_AGENT_CONFIG;

// ─────────────────────────────────────────────
// 5. Appeal Agent 配置
// ─────────────────────────────────────────────
export const APPEAL_AGENT_CONFIG = {
  // 申诉处理配置
  appealProcessConfig: {
    responseTimeSLA: 86400000, // 24小时
    reviewRequired: true,
    autoApproval: false,
    escalationThreshold: 3
  },

  // 仲裁规则配置
  arbitrationRules: {
    validAppealReasons: [
      '数据错误',
      '系统误判',
      '外部因素',
      '特殊情况'
    ],
    requiredEvidence: {
      '数据错误': ['系统截图', '数据报告'],
      '系统误判': ['操作记录', '现场照片'],
      '外部因素': ['证明文件', '第三方说明'],
      '特殊情况': ['情况说明', '相关证明']
    }
  },

  // 执行配置
  executionConfig: {
    maxAppealDuration: 604800000, // 7天
    notificationEnabled: true,
    reportGeneration: true
  }
};

// ─────────────────────────────────────────────
// 6. Master Agent 配置
// ─────────────────────────────────────────────
export const MASTER_AGENT_CONFIG = {
  // 状态流转配置
  statusFlowConfig: {
    pending_audit: { next: ['auditing'], agent: 'data_auditor' },
    auditing: { next: ['pending_dispatch', 'closed'], agent: 'data_auditor' },
    pending_dispatch: { next: ['dispatched'], agent: 'master' },
    dispatched: { next: ['pending_response'], agent: 'ops_supervisor' },
    pending_response: { next: ['pending_review'], agent: 'master' },
    pending_review: { next: ['resolved', 'rejected'], agent: 'ops_supervisor' },
    resolved: { next: ['pending_settlement'], agent: 'master' },
    rejected: { next: ['pending_dispatch'], agent: 'master' },
    pending_settlement: { next: ['settled'], agent: 'chief_evaluator' },
    settled: { next: ['closed'], agent: 'master' },
    closed: { next: [], agent: null }
  },

  // 责任人映射配置
  responsibilityMapping: {
    '厨房/出品问题': 'store_production_manager',
    '前厅/服务问题': 'store_manager',
    '财务/成本问题': 'store_manager',
    '安全/卫生问题': 'store_manager',
    '设备/维护问题': 'store_manager'
  },

  // 执行配置
  executionConfig: {
    pollingInterval: 30000, // 30秒
    maxConcurrentTasks: 100,
    taskTimeout: 86400000, // 24小时
    retryAttempts: 3
  }
};

// ─────────────────────────────────────────────
// 7. 统一配置管理器
// ─────────────────────────────────────────────
export class AgentConfigManager {
  static getConfig(agentType) {
    switch (agentType) {
      case 'data_auditor':
        return DATA_AUDITOR_CONFIG;
      case 'ops_supervisor':
        return OPS_AGENT_CONFIG;
      case 'chief_evaluator':
        return CHIEF_EVALUATOR_CONFIG;
      case 'train_advisor':
      case 'sop_advisor': // 兼容旧标识
        return TRAIN_AGENT_CONFIG;
      case 'appeal':
        return APPEAL_AGENT_CONFIG;
      case 'master':
        return MASTER_AGENT_CONFIG;
      default:
        throw new Error(`Unknown agent type: ${agentType}`);
    }
  }

  static validateAllConfigs() {
    const errors = [];
    
    // 验证评分配置
    const scoringErrors = validateScoringConfig();
    errors.push(...scoringErrors);
    
    // 验证权重总和
    for (const [brand, model] of Object.entries(UNIFIED_BRAND_SCORING_MODELS)) {
      const totalWeight = Object.values(model.dimensions).reduce((sum, dim) => sum + dim.weight, 0);
      if (Math.abs(totalWeight - 1.0) > 0.01) {
        errors.push(`品牌 ${brand} 权重总和不为1.0: ${totalWeight}`);
      }
    }
    
    return errors;
  }

  static getAgentResponsibilities(agentType) {
    const responsibilities = {
      'data_auditor': [
        '统一管理所有数据源',
        '发现和分类异常',
        '确定责任人角色',
        '不负责评分计算'
      ],
      'ops_supervisor': [
        '任务派发和跟踪',
        '执行质量监督',
        '图片审核（不扣分）',
        '结果反馈给OKR'
      ],
      'chief_evaluator': [
        '统一管理评分规则',
        '计算最终绩效',
        '管理品牌评分模型',
        '生成绩效报告'
      ],
      'train_advisor': [
        '知识库检索与SOP标准咨询',
        '品牌差异化支持与操作指导',
        '制定培训战略与体系搭建',
        '人才发展、梯队培养、领导力发展',
        '培训需求分析与年度培训计划',
        '管理层培训、关键岗位赋能、企业文化落地',
        '新员工入职培训、岗位技能培训',
        '培训课件制作、资料整理与更新',
        '培训反馈收集、效果评估与ROI分析',
        '管理培训团队、内训师与讲师资源'
      ],
      'appeal': [
        '申诉处理',
        '证据核实',
        '人工仲裁',
        '结果反馈'
      ],
      'master': [
        '消息路由',
        '任务状态流转',
        '全局上下文管理',
        'Agent协调调度'
      ]
    };
    
    return responsibilities[agentType] || [];
  }
}

// ─────────────────────────────────────────────
// 8. 配置导出
// ─────────────────────────────────────────────
export default {
  DATA_AUDITOR_CONFIG,
  OPS_AGENT_CONFIG,
  CHIEF_EVALUATOR_CONFIG,
  TRAIN_AGENT_CONFIG,
  SOP_AGENT_CONFIG, // 兼容别名
  APPEAL_AGENT_CONFIG,
  MASTER_AGENT_CONFIG,
  AgentConfigManager
};
