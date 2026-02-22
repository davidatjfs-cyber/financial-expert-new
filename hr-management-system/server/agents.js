/**
 * HRMS Multi-Agent System — Feishu-First Architecture
 *
 * HRMS = 大脑 + 数据处理中心
 * 飞书 = 唯一交互通道（单聊推送 / 接收回复）
 *
 * Agents:
 *   1. Data Auditor        (数据审计员) — 异常检测 → 飞书推送
 *   2. Operational Supervisor (营运督导员) — 图片审核 / 反作弊
 *   3. HR Agent           (HR专员) — 绩效评分 / 人事管理
 *   4. SOP Advisor         (SOP顾问)   — 知识库问答
 *
 * Flow:
 *   Scheduler → Agent 发现异常 → 飞书推送给店长
 *   店长在飞书回复文字/照片/语音 → webhook → Agent 处理 → 飞书回复
 */

import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import crypto from 'crypto';
import { 
  calculateStoreRating, 
  calculateEmployeeScore 
} from './new-scoring-model.js';
import { 
  AgentCommunicationSystem, 
  AgentCommunicationHelper 
} from './agent-communication-system.js';
import { pool as agentPool, setPool as setUnifiedAgentPool } from './utils/database.js';
import { safeExecute, safeErrorLog } from './utils/error-handler.js';
import { handleMarginMessage } from './margin-message-handler.js';
import { deduplicateMessage } from './message-deduplication.js';

// ─────────────────────────────────────────────
// 0. Config
// ─────────────────────────────────────────────

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || process.env.ARK_API_KEY || '';
const DEEPSEEK_BASE_URL = process.env.DEEPSEEK_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3';
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-v3-250324';
const DEEPSEEK_VISION_MODEL = process.env.DEEPSEEK_VISION_MODEL || 'doubao-seed-2-0-pro-260215';

const LARK_APP_ID = process.env.LARK_APP_ID || '';
const LARK_APP_SECRET = process.env.LARK_APP_SECRET || '';
const LARK_ENCRYPT_KEY = process.env.LARK_ENCRYPT_KEY || '';
const LARK_VERIFICATION_TOKEN = process.env.LARK_VERIFICATION_TOKEN || '';

// Bitable Configuration - 支持多个配置
const BITABLE_CONFIGS = {
  'ops_checklist': {
    appId: process.env.BITABLE_OPS_APP_ID || 'cli_a91dae9f9578dcb1',
    appSecret: process.env.BITABLE_OPS_APP_SECRET || 'sjpAzPwu4KixvhbAOD7w4ee1oEKRRBQF',
    appToken: process.env.BITABLE_OPS_APP_TOKEN || 'PtVObRtoPaMAP3stIIFc8DnJngd',
    tableId: process.env.BITABLE_OPS_TABLE_ID || 'tblxHI9ZAKONOTpp',
    name: '运营检查表',
    type: 'checklist',
    pollingInterval: 60000
  },
  'table_visit': {
    appId: process.env.BITABLE_TABLEVISIT_APP_ID || 'cli_a9fc0d13c838dcd6',
    appSecret: process.env.BITABLE_TABLEVISIT_APP_SECRET || 'pRVuBmiWc0hzqP1YzZDqzGUPFlaProDN',
    appToken: process.env.BITABLE_TABLEVISIT_APP_TOKEN || 'PTWrbUdcbarCshst0QncMoY7nKe',
    tableId: process.env.BITABLE_TABLEVISIT_TABLE_ID || 'tblpx5Efqc6eHo3L',
    name: '桌访表',
    type: 'table_visit',
    pollingInterval: 300000  // 5分钟轮询
  },
  // 新增5个表格配置
  'closing_reports': {
    appId: process.env.BITABLE_CLOSING_APP_ID || 'cli_a9fc0d13c838dcd6',
    appSecret: process.env.BITABLE_CLOSING_APP_SECRET || 'pRVuBmiWc0hzqP1YzZDqzGUPFlaProDN',
    appToken: process.env.BITABLE_CLOSING_APP_TOKEN || 'PTWrbUdcbarCshst0QncMoY7nKe',
    tableId: process.env.BITABLE_CLOSING_TABLE_ID || 'tblXYfSBRrgNGohN',
    name: '收档报告DB',
    type: 'closing_report',
    pollingInterval: 300000
  },
  'opening_reports': {
    appId: process.env.BITABLE_OPENING_APP_ID || 'cli_a9fc0d13c838dcd6',
    appSecret: process.env.BITABLE_OPENING_APP_SECRET || 'pRVuBmiWc0hzqP1YzZDqzGUPFlaProDN',
    appToken: process.env.BITABLE_OPENING_APP_TOKEN || 'PTWrbUdcbarCshst0QncMoY7nKe',
    tableId: process.env.BITABLE_OPENING_TABLE_ID || 'tbl32E6d0CyvLvfi',
    name: '开档报告',
    type: 'opening_report',
    pollingInterval: 300000
  },
  'meeting_reports': {
    appId: process.env.BITABLE_MEETING_APP_ID || 'cli_a9fc0d13c838dcd6',
    appSecret: process.env.BITABLE_MEETING_APP_SECRET || 'pRVuBmiWc0hzqP1YzZDqzGUPFlaProDN',
    appToken: process.env.BITABLE_MEETING_APP_TOKEN || 'PTWrbUdcbarCshst0QncMoY7nKe',
    tableId: process.env.BITABLE_MEETING_TABLE_ID || 'tblZXgaU0LpSye2m',
    name: '例会报告',
    type: 'meeting_report',
    pollingInterval: 300000
  },
  'material_majixian': {
    appId: process.env.BITABLE_MATERIAL_MJX_APP_ID || 'cli_a9fc0d13c838dcd6',
    appSecret: process.env.BITABLE_MATERIAL_MJX_APP_SECRET || 'pRVuBmiWc0hzqP1YzZDqzGUPFlaProDN',
    appToken: process.env.BITABLE_MATERIAL_MJX_APP_TOKEN || 'PTWrbUdcbarCshst0QncMoY7nKe',
    tableId: process.env.BITABLE_MATERIAL_MJX_TABLE_ID || 'tblz4kW1cY22XRlL',
    name: '马己仙原料收货日报',
    type: 'material_report',
    brand: 'majixian',
    pollingInterval: 300000
  },
  'material_hongchao': {
    appId: process.env.BITABLE_MATERIAL_HC_APP_ID || 'cli_a9fc0d13c838dcd6',
    appSecret: process.env.BITABLE_MATERIAL_HC_APP_SECRET || 'pRVuBmiWc0hzqP1YzZDqzGUPFlaProDN',
    appToken: process.env.BITABLE_MATERIAL_HC_APP_TOKEN || 'PTWrbUdcbarCshst0QncMoY7nKe',
    tableId: process.env.BITABLE_MATERIAL_HC_TABLE_ID || 'tbllcV1evqTJyzlN',
    name: '洪潮原料收货日报',
    type: 'material_report',
    brand: 'hongchao',
    pollingInterval: 300000
  }
};

// 向后兼容的默认配置
const BITABLE_APP_ID = process.env.BITABLE_APP_ID || BITABLE_CONFIGS.ops_checklist.appId;
const BITABLE_APP_SECRET = process.env.BITABLE_APP_SECRET || BITABLE_CONFIGS.ops_checklist.appSecret;
const BITABLE_APP_TOKEN = process.env.BITABLE_APP_TOKEN || BITABLE_CONFIGS.ops_checklist.appToken;
const BITABLE_TABLE_ID = process.env.BITABLE_TABLE_ID || BITABLE_CONFIGS.ops_checklist.tableId;

const BRAND_ANALYSIS_CONFIG = {
  '洪潮': {
    marginTolerance: 0.01,
    scoreWeights: { quality: 0.4, cost: 0.3, response: 0.3 },
    label: '洪潮模式'
  },
  '马己仙': {
    marginTolerance: 0.02,
    scoreWeights: { efficiency: 0.4, cost: 0.4, execution: 0.2 },
    label: '马己仙模式'
  }
};

function normalizeBrandId(input) {
  const raw = String(input || '').trim().toLowerCase();
  if (!raw) return '';
  return raw
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
}

// 品牌配置
const BRAND_CONFIG = {
  '洪潮': {
    name: '洪潮',
    fullName: '洪潮传统潮汕菜',
    checkItems: {
      opening: ['地面清洁无积水', '所有设备正常开启', '食材新鲜度检查', '餐具消毒完成', '灯光亮度适中', '背景音乐开启', '空调温度设置合适', '员工仪容仪表检查'],
      closing: ['食材封存', '设备关闭', '垃圾清理', '安全检查', '门窗锁好']
    },
    standards: {
      quality: '高标准食材，新鲜度要求严格',
      service: '热情周到，响应及时',
      environment: '干净整洁，氛围舒适'
    }
  },
  '马己仙': {
    name: '马己仙',
    fullName: '马己仙',
    checkItems: {
      opening: ['地面清洁', '设备开启', '食材准备', '餐具消毒', '迎宾准备'],
      closing: ['食材封存', '设备关闭', '垃圾清理', '安全检查', '门窗锁好', '电源关闭']
    },
    standards: {
      quality: '精致料理，注重细节',
      service: '优雅服务，体验至上',
      environment: '高雅环境，品质生活'
    }
  }
};

function fallbackBrandConfigByName(brandName) {
  const name = String(brandName || '').trim();
  if (name.includes('马己仙')) return BRAND_CONFIG['马己仙'];
  return BRAND_CONFIG['洪潮'];
}

function getBrandsFromState(state0) {
  const state = state0 && typeof state0 === 'object' ? state0 : {};
  const stores = Array.isArray(state?.stores) ? state.stores : [];
  const existing = Array.isArray(state?.brands) ? state.brands : [];
  const map = new Map();

  existing.forEach((b) => {
    const name = String(b?.name || b?.label || '').trim();
    const id = normalizeBrandId(b?.id || b?.brandId || name);
    if (!name || !id) return;
    map.set(id, {
      id,
      name,
      config: b?.config && typeof b.config === 'object' ? b.config : {}
    });
  });

  stores.forEach((s) => {
    const name = String(s?.brand || s?.brandName || '').trim();
    const id = normalizeBrandId(s?.brandId || name);
    if (!name || !id || map.has(id)) return;
    map.set(id, { id, name, config: {} });
  });

  return Array.from(map.values());
}

function getBrandRuntimeConfig(state0, brandContext) {
  const brandName = String(brandContext?.brandName || '').trim();
  const fallback = fallbackBrandConfigByName(brandName);
  const custom = brandContext?.brandConfig && typeof brandContext.brandConfig === 'object' ? brandContext.brandConfig : {};
  return {
    ...fallback,
    ...custom,
    scoreWeights: custom?.scoreWeights && typeof custom.scoreWeights === 'object'
      ? custom.scoreWeights
      : fallback.scoreWeights,
    sopKeypoints: Array.isArray(custom?.sopKeypoints) ? custom.sopKeypoints : []
  };
}

function buildOpsChecklistItemDetailCard({ checkType, brandName, storeName, itemIndex, itemName, detail = {} }) {
  const typeLabel = checkType === 'opening' ? '开市' : '收档';
  const statusLabel = detail.status === 'fail' ? '异常' : detail.status === 'pass' ? '合格' : '未选择';
  const remark = String(detail.remark || '').trim() || '未填写';
  const photoCount = Number(detail.photoCount) || 0;

  return {
    config: { wide_screen_mode: true, enable_forward: true },
    header: {
      title: { tag: 'plain_text', content: `${typeLabel}检查项填写` },
      template: 'indigo'
    },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `**门店**：${storeName || '-'}\n**品牌**：${brandName || '-'}\n**检查项**：${itemIndex + 1}. ${itemName}`
        }
      },
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `当前状态：${statusLabel}\n说明：${remark}\n已上传照片：${photoCount} 张\n\n下一步：先点击“合格/异常”，再直接在会话发送“说明：xxx”，然后上传照片。`
        }
      },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            type: 'primary',
            text: { tag: 'plain_text', content: '✅ 本项合格' },
            value: { action: 'ops_checklist_item_status', checkType, itemIndex: String(itemIndex), itemName, status: 'pass' }
          },
          {
            tag: 'button',
            type: 'danger',
            text: { tag: 'plain_text', content: '⚠️ 本项异常' },
            value: { action: 'ops_checklist_item_status', checkType, itemIndex: String(itemIndex), itemName, status: 'fail' }
          }
        ]
      }
    ]
  };
}

const _opsChecklistProgress = new Map();

// M3-FIX: 定期清理过期的检查表进度（每30分钟清理超过2小时的条目）
setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  for (const [key, progress] of _opsChecklistProgress.entries()) {
    const createdAt = progress?.createdAt || 0;
    if (now - createdAt > 2 * 60 * 60 * 1000) { // 2小时过期
      _opsChecklistProgress.delete(key);
      cleaned++;
    }
  }
  if (cleaned > 0) console.log(`[ops] cleaned ${cleaned} expired checklist progress entries`);
}, 30 * 60 * 1000);

function getOpsChecklistProgressKey(openId, checkType, storeName) {
  const day = new Date().toISOString().slice(0, 10);
  return `${openId}||${storeName || '-'}||${checkType}||${day}`;
}

function countOpsChecklistCompleted(progress) {
  const details = progress?.itemDetails && typeof progress.itemDetails === 'object' ? progress.itemDetails : {};
  let done = 0;
  for (const v of Object.values(details)) {
    const statusOk = v && (v.status === 'pass' || v.status === 'fail');
    const remarkOk = String(v?.remark || '').trim().length > 0;
    if (statusOk && remarkOk) done += 1;
  }
  return done;
}

function countOpsChecklistAbnormal(progress) {
  const details = progress?.itemDetails && typeof progress.itemDetails === 'object' ? progress.itemDetails : {};
  let cnt = 0;
  for (const v of Object.values(details)) {
    if (v && v.status === 'fail') cnt += 1;
  }
  return cnt;
}

function buildOpsChecklistItemsCard({ checkType, brandName, storeName, checkedIndices = new Set() }) {
  const typeLabel = checkType === 'opening' ? '开市' : '收档';
  const items = getOpsChecklistItems(checkType, brandName);
  const rows = (items.length ? items : ['现场环境检查', '设备状态检查', '安全规范检查'])
    .map((item, idx) => {
      const done = checkedIndices.has(idx);
      return {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            type: done ? 'primary' : 'default',
            text: { tag: 'plain_text', content: `${done ? '✅' : '⬜'} ${idx + 1}. ${item}` },
            value: { action: 'ops_checklist_item_focus', checkType, itemIndex: String(idx), itemName: item }
          }
        ]
      };
    });

  return {
    config: { wide_screen_mode: true, enable_forward: true },
    header: {
      title: { tag: 'plain_text', content: `${typeLabel}逐项勾选` },
      template: 'blue'
    },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `**门店**：${storeName || '-'}\n**品牌**：${brandName || '-'}\n点击每一项完成勾选。`
        }
      },
      ...rows
    ]
  };
}

function buildOpsChecklistAbnormalItemsCard({ checkType, brandName, storeName }) {
  const typeLabel = checkType === 'opening' ? '开市' : '收档';
  const items = getOpsChecklistItems(checkType, brandName);
  const rows = (items.length ? items : ['现场环境', '设备状态', '安全规范'])
    .map((item, idx) => ({
      tag: 'action',
      actions: [
        {
          tag: 'button',
          type: 'danger',
          text: { tag: 'plain_text', content: `⚠️ ${idx + 1}. ${item}` },
          value: { action: 'ops_checklist_abnormal_item', checkType, itemIndex: String(idx), itemName: item }
        }
      ]
    }));

  rows.push({
    tag: 'action',
    actions: [
      {
        tag: 'button',
        type: 'danger',
        text: { tag: 'plain_text', content: '⚠️ 其他异常' },
        value: { action: 'ops_checklist_abnormal_item', checkType, itemIndex: '-1', itemName: '其他异常' }
      }
    ]
  });

  return {
    config: { wide_screen_mode: true, enable_forward: true },
    header: {
      title: { tag: 'plain_text', content: `${typeLabel}异常项选择` },
      template: 'red'
    },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `**门店**：${storeName || '-'}\n**品牌**：${brandName || '-'}\n请选择异常项（可多次点击提交）。`
        }
      },
      ...rows
    ]
  };
}

function detectOpsChecklistType(text) {
  const t = String(text || '').trim();
  if (!t) return '';
  if (t.includes('开市') || t.includes('开档')) return 'opening';
  if (t.includes('收档') || t.includes('收市') || t.includes('闭市')) return 'closing';
  return '';
}

function getOpsChecklistItems(checkType, brandName) {
  const daily = OPS_AGENT_CONFIG?.scheduledTasks?.dailyInspections || [];
  let target = daily.find(i => i.type === checkType && i.brand === brandName);
  if (!target) target = daily.find(i => i.type === checkType);
  return Array.isArray(target?.checklist) ? target.checklist : [];
}

function buildOpsChecklistCard({ checkType, brandName, storeName, abnormalCount = 0, totalCount = 0 }) {
  const typeLabel = checkType === 'opening' ? '开市' : '收档';
  const items = getOpsChecklistItems(checkType, brandName);
  const listMd = items.length
    ? items.map((item, idx) => `${idx + 1}. ${item}`).join('\n')
    : '1. 现场环境检查\n2. 设备状态检查\n3. 安全规范检查';

  return {
    config: { wide_screen_mode: true, enable_forward: true },
    header: {
      title: { tag: 'plain_text', content: `${typeLabel}检查表（异常${abnormalCount}项）` },
      template: 'blue'
    },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `**门店**：${storeName || '-'}\n**品牌**：${brandName || '-'}\n默认全部合格，仅需选择异常项并补充说明/照片。`
        }
      },
      { tag: 'hr' },
      { tag: 'div', text: { tag: 'lark_md', content: `检查项：\n${listMd}` } },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            type: 'primary',
            text: { tag: 'plain_text', content: '✅ 直接提交（其余默认合格）' },
            value: { action: 'ops_checklist_submit', checkType }
          },
          {
            tag: 'button',
            type: 'danger',
            text: { tag: 'plain_text', content: '⚠️ 选择异常项（可多次）' },
            value: { action: 'ops_checklist_abnormal_open', checkType }
          }
        ]
      }
    ]
  };
}

function buildOpsChecklistTemplateText({ checkType, brandName, storeName }) {
  const typeLabel = checkType === 'opening' ? '开市' : '收档';
  const items = getOpsChecklistItems(checkType, brandName);
  const lines = items.length
    ? items.map((item, idx) => `${idx + 1}. ${item}: [合格/异常] 备注:[ ]`).join('\n')
    : '1. 现场环境: [合格/异常] 备注:[ ]\n2. 设备状态: [合格/异常] 备注:[ ]\n3. 安全规范: [合格/异常] 备注:[ ]';
  return `【${typeLabel}检查标准模板】\n门店: ${storeName || '-'}\n品牌: ${brandName || '-'}\n\n${lines}\n\n异常说明: [如无填 无]\n整改完成时间: [YYYY-MM-DD HH:mm]\n上传照片数量: [N]\n\n请按以上格式直接回复，系统将自动结构化入库。`;
}

async function handleOpsChecklistCardAction(event) {
  const openId = String(
    event?.operator?.operator_id?.open_id ||
    event?.operator?.open_id ||
    event?.user?.open_id || ''
  ).trim();
  if (!openId) return { ok: true, skipped: 'no_open_id' };

  const actionValue = event?.action?.value || {};
  const action = String(actionValue.action || '').trim();
  if (!action.startsWith('ops_checklist_')) return { ok: true, skipped: 'not_ops_checklist_action' };

  const feishuUser = await lookupFeishuUser(openId);
  if (!feishuUser || !feishuUser.registered) {
    await sendLarkMessage(openId, '请先完成HRMS账号绑定后再提交检查表。');
    return { ok: true, skipped: 'unregistered_user' };
  }

  const sharedState = await getSharedState();
  const brandContext = resolveBrandContextByStore(sharedState, feishuUser.store || '');
  const brandName = String(brandContext?.brandName || '').trim();
  const storeName = String(feishuUser.store || '').trim();
  const checkType = String(actionValue.checkType || '').trim() || 'opening';
  const progressKey = getOpsChecklistProgressKey(openId, checkType, storeName);
  const checklistItems = getOpsChecklistItems(checkType, brandName);

  if (!_opsChecklistProgress.has(progressKey)) {
    _opsChecklistProgress.set(progressKey, {
      checked: new Set(),
      items: checklistItems,
      itemDetails: {},
      pendingItemIndex: null,
      pendingItemName: ''
    });
  }
  const progress = _opsChecklistProgress.get(progressKey);
  if (Array.isArray(progress?.items) && progress.items.length === 0 && checklistItems.length) {
    progress.items = checklistItems;
  }

  if (action === 'ops_checklist_abnormal_open') {
    const card = buildOpsChecklistAbnormalItemsCard({ checkType, brandName, storeName });
    const sendRes = await sendLarkCard(openId, card);
    if (!sendRes.ok) {
      await sendLarkMessage(openId, prefixWithAgentName('ops_supervisor', '异常项选择卡片发送失败，请稍后重试。'));
      return { toast: { type: 'error', content: '异常项卡片发送失败' }, ok: true, checklistAction: 'abnormal_open_failed' };
    }
    return {
      toast: { type: 'info', content: '请选择异常项提交' },
      ok: true,
      route: 'ops_supervisor',
      checklistAction: 'abnormal_opened'
    };
  }

  if (action === 'ops_checklist_abnormal_item') {
    const itemName = String(actionValue.itemName || '其他异常').trim() || '其他异常';
    const typeLabel = checkType === 'opening' ? '开市' : '收档';
    const structured = {
      source: 'feishu_card_action',
      route: 'ops_supervisor',
      checkType,
      checkTypeLabel: typeLabel,
      status: 'fail',
      brand: brandName,
      store: storeName,
      username: feishuUser.username,
      abnormalItem: itemName,
      submittedAt: new Date().toISOString()
    };

    try {
      await pool().query(
        `INSERT INTO agent_messages (direction, channel, feishu_open_id, sender_username, sender_name, sender_role, routed_to, content_type, content, agent_data)
         VALUES ('in','feishu',$1,$2,$3,$4,'ops_supervisor','card_action',$5,$6::jsonb)`,
        [openId, feishuUser.username, feishuUser.name || feishuUser.username, feishuUser.role || '', `${typeLabel}异常项提交：${itemName}`, JSON.stringify(structured)]
      );
    } catch (e) {
      console.error('[ops] save checklist abnormal item failed:', e?.message);
    }

    progress.pendingItemIndex = Number.parseInt(String(actionValue.itemIndex || '-1'), 10);
    progress.pendingItemName = itemName;
    if (Number.isFinite(progress.pendingItemIndex) && progress.pendingItemIndex >= 0) {
      if (!progress.itemDetails[progress.pendingItemIndex]) progress.itemDetails[progress.pendingItemIndex] = { status: '', remark: '', photoCount: 0 };
      progress.itemDetails[progress.pendingItemIndex].status = 'fail';
    }

    await sendLarkMessage(openId, prefixWithAgentName('ops_supervisor', `已记录异常项：${itemName}。\n请直接回复：说明：你的说明\n并上传该项现场照片。`));
    return {
      toast: { type: 'success', content: `已提交异常：${itemName}` },
      ok: true,
      route: 'ops_supervisor',
      checklistAction: 'abnormal_item_submitted'
    };
  }

  if (action === 'ops_checklist_submit') {
    const typeLabel = checkType === 'opening' ? '开市' : '收档';
    const items = progress?.items?.length ? progress.items : checklistItems;
    const total = Math.max(1, items.length);
    const abnormalCount = countOpsChecklistAbnormal(progress);

    const standardized = {
      source: 'feishu_card_action',
      route: 'ops_supervisor',
      checkType,
      checkTypeLabel: typeLabel,
      status: abnormalCount > 0 ? 'fail' : 'pass',
      brand: brandName,
      store: storeName,
      username: feishuUser.username,
      checklist: items,
      checklistProgress: { total, abnormalCount, passCount: Math.max(0, total - abnormalCount) },
      itemDetails: progress?.itemDetails || {},
      submittedAt: new Date().toISOString()
    };

    try {
      await pool().query(
        `INSERT INTO agent_messages (direction, channel, feishu_open_id, sender_username, sender_name, sender_role, routed_to, content_type, content, agent_data)
         VALUES ('in','feishu',$1,$2,$3,$4,'ops_supervisor','card_action',$5,$6::jsonb)`,
        [openId, feishuUser.username, feishuUser.name || feishuUser.username, feishuUser.role || '', `${typeLabel}检查表提交（异常${abnormalCount}项）`, JSON.stringify(standardized)]
      );
    } catch (e) {
      console.error('[ops] save checklist card action failed:', e?.message);
    }

    const reply = `已收到你的${typeLabel}检查表提交 ✅\n异常项：${abnormalCount}，其余默认合格。\n如需补充异常说明/照片，可继续发送“说明：xxx”+图片。`;
    await sendLarkMessage(openId, prefixWithAgentName('ops_supervisor', reply));
    _opsChecklistProgress.delete(progressKey);
    return {
      toast: { type: 'success', content: '检查表已提交' },
      ok: true,
      route: 'ops_supervisor',
      checklistAction: 'submit'
    };
  }

  return { ok: true, skipped: 'unknown_ops_action' };
}

export function resolveBrandContextByStore(state0, storeRef) {
  const state = state0 && typeof state0 === 'object' ? state0 : {};
  const stores = Array.isArray(state?.stores) ? state.stores : [];
  const brands = getBrandsFromState(state);
  const byId = new Map(brands.map((b) => [String(b.id || ''), b]));
  const ref = String(storeRef || '').trim();
  const row = stores.find((s) => String(s?.id || '').trim() === ref || String(s?.name || '').trim() === ref) || null;
  const storeName = String(row?.name || ref || '').trim();
  const brandNameFromStore = String(row?.brand || row?.brandName || '').trim();
  const brandId = normalizeBrandId(row?.brandId || brandNameFromStore || inferBrandFromStoreName(storeName));
  const brand = byId.get(brandId) || null;
  const brandName = String(brand?.name || brandNameFromStore || inferBrandFromStoreName(storeName) || '').trim();
  const brandConfig = brand?.config && typeof brand.config === 'object' ? brand.config : {};
  return {
    storeId: String(row?.id || '').trim(),
    storeName,
    brandId,
    brandName,
    brandConfig
  };
}

// ─────────────────────────────────────────────
// 1. Database / Blackboard
// ─────────────────────────────────────────────

let _pool = null;
export function setPool(p) { 
  _pool = p; 
  setUnifiedAgentPool(p); // 同时设置统一数据库连接
}
export function pool() { 
  if (!_pool) throw new Error('agents: pool not set'); 
  return _pool; 
}

// Hook for Master Agent task response handler (set by master-agent.js to avoid circular import)
let _taskResponseHook = null;
export function setTaskResponseHook(fn) { _taskResponseHook = fn; }

export async function ensureAgentTables() {
  const client = await pool().connect();
  try {
    await client.query('BEGIN');

    await client.query(`
      CREATE TABLE IF NOT EXISTS agent_issues (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        agent VARCHAR(60) NOT NULL,
        brand VARCHAR(120),
        store VARCHAR(200),
        category VARCHAR(120),
        severity VARCHAR(20) NOT NULL DEFAULT 'medium',
        title VARCHAR(500) NOT NULL,
        detail TEXT,
        data JSONB NOT NULL DEFAULT '{}'::jsonb,
        status VARCHAR(30) NOT NULL DEFAULT 'open',
        assignee_username VARCHAR(100),
        resolved_at TIMESTAMP,
        resolution TEXT,
        feishu_notified BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS agent_messages (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        direction VARCHAR(10) NOT NULL DEFAULT 'in',
        channel VARCHAR(30) NOT NULL DEFAULT 'feishu',
        feishu_open_id VARCHAR(200),
        sender_username VARCHAR(200),
        sender_name VARCHAR(200),
        sender_role VARCHAR(60),
        routed_to VARCHAR(60),
        content_type VARCHAR(30) NOT NULL DEFAULT 'text',
        content TEXT,
        image_urls JSONB DEFAULT '[]'::jsonb,
        agent_response TEXT,
        agent_data JSONB DEFAULT '{}'::jsonb,
        feishu_message_id VARCHAR(200),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS agent_scores (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        brand VARCHAR(120) NOT NULL,
        store VARCHAR(200) NOT NULL,
        username VARCHAR(100) NOT NULL,
        role VARCHAR(60),
        period VARCHAR(20) NOT NULL,
        score_model VARCHAR(60),
        base_score NUMERIC(5,1) NOT NULL DEFAULT 100,
        total_score NUMERIC(5,1) NOT NULL DEFAULT 100,
        additions JSONB NOT NULL DEFAULT '[]'::jsonb,
        deductions JSONB NOT NULL DEFAULT '[]'::jsonb,
        breakdown JSONB NOT NULL DEFAULT '{}'::jsonb,
        summary TEXT,
        feishu_notified BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT uq_agent_scores_period UNIQUE (brand, store, username, period)
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS agent_appeals (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        issue_id UUID,
        score_id UUID,
        username VARCHAR(100) NOT NULL,
        reason TEXT NOT NULL,
        status VARCHAR(30) NOT NULL DEFAULT 'pending',
        agent_verdict TEXT,
        agent_data JSONB DEFAULT '{}'::jsonb,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        resolved_at TIMESTAMP
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS agent_visual_audits (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        store VARCHAR(200),
        brand VARCHAR(120),
        username VARCHAR(100) NOT NULL,
        image_url TEXT NOT NULL,
        audit_type VARCHAR(60),
        result VARCHAR(30) NOT NULL DEFAULT 'pending',
        confidence NUMERIC(4,2),
        findings TEXT,
        exif_time TIMESTAMP,
        exif_gps TEXT,
        image_hash VARCHAR(64),
        duplicate_of UUID,
        agent_raw JSONB DEFAULT '{}'::jsonb,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // 差评报告DB - 手动上传的差评数据
    await client.query(`
      CREATE TABLE IF NOT EXISTS bad_reviews (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        date DATE NOT NULL,
        store VARCHAR(200) NOT NULL,
        brand VARCHAR(120),
        review_type VARCHAR(30) NOT NULL,  -- 'product' 或 'service'
        content TEXT NOT NULL,
        product_name VARCHAR(200),          -- 产品名称（产品差评时）
        service_item VARCHAR(200),          -- 服务项目（服务差评时）
        rating INT,                         -- 评分（如有）
        platform VARCHAR(60),               -- 来源平台：大众点评/美团/饿了么等
        order_id VARCHAR(100),              -- 订单ID（如有）
        customer_name VARCHAR(100),         -- 顾客名称（如有）
        has_detailed_event BOOLEAN DEFAULT FALSE,  -- 是否有详细事件过程
        event_detail TEXT,                  -- 详细事件过程描述
        sop_case_id UUID,                   -- 关联的SOP案例分析ID
        status VARCHAR(30) DEFAULT 'open',  -- open/processing/resolved
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_bad_reviews_store_date ON bad_reviews (store, date)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_bad_reviews_type ON bad_reviews (review_type, product_name, service_item)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_bad_reviews_detailed ON bad_reviews (has_detailed_event) WHERE has_detailed_event = TRUE`);

    // Feishu ↔ HRMS user mapping
    await client.query(`
      CREATE TABLE IF NOT EXISTS feishu_users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        open_id VARCHAR(200) NOT NULL UNIQUE,
        username VARCHAR(100),
        name VARCHAR(200),
        mobile VARCHAR(30),
        store VARCHAR(200),
        role VARCHAR(60),
        registered BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await client.query(`CREATE INDEX IF NOT EXISTS idx_agent_issues_store ON agent_issues (store, status)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_agent_issues_assignee ON agent_issues (assignee_username, status)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_agent_messages_sender ON agent_messages (feishu_open_id, created_at DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_agent_scores_user ON agent_scores (username, period)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_agent_visual_store ON agent_visual_audits (store, created_at DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_feishu_users_openid ON feishu_users (open_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_feishu_users_username ON feishu_users (username)`);

    // Add feishu_notified column if missing (migration for existing tables)
    try { await client.query(`ALTER TABLE agent_issues ADD COLUMN IF NOT EXISTS feishu_notified BOOLEAN DEFAULT FALSE`); } catch (e) {}
    try { await client.query(`ALTER TABLE agent_scores ADD COLUMN IF NOT EXISTS feishu_notified BOOLEAN DEFAULT FALSE`); } catch (e) {}
    // Add name column to agent_scores (migration)
    try { await client.query(`ALTER TABLE agent_scores ADD COLUMN IF NOT EXISTS name VARCHAR(200)`); } catch (e) {}

    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    const code = String(e?.code || '');
    if (code === '23505') return;
    console.error('[agents] ensureAgentTables failed:', e?.message || e);
  } finally {
    client.release();
  }
}

// ─────────────────────────────────────────────
// 2. LLM Helpers & Context Management
// ─────────────────────────────────────────────

// 上下文缓存：存储最近的对话历史
// M2-FIX: 添加最大用户数限制，防止内存泄漏
const _conversationContext = new Map();
const MAX_CONTEXT_LENGTH = 10;
const MAX_CONTEXT_USERS = 500;

// 响应缓存：避免重复调用LLM
const _responseCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5分钟缓存

// 性能监控
const _performanceMetrics = {
  totalCalls: 0,
  cacheHits: 0,
  avgResponseTime: 0,
  errorCount: 0
};

function getCachedResponse(cacheKey) {
  const cached = _responseCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    _performanceMetrics.cacheHits++;
    return cached.response;
  }
  return null;
}

function setCachedResponse(cacheKey, response) {
  _responseCache.set(cacheKey, {
    response,
    timestamp: Date.now()
  });
  
  // 清理过期缓存
  if (_responseCache.size > 100) {
    const now = Date.now();
    for (const [key, value] of _responseCache.entries()) {
      if (now - value.timestamp > CACHE_TTL) {
        _responseCache.delete(key);
      }
    }
  }
}

function updateContext(userId, role, content) {
  if (!_conversationContext.has(userId)) {
    _conversationContext.set(userId, []);
  }
  const context = _conversationContext.get(userId);
  context.push({ role, content, timestamp: Date.now() });
  
  // 保持最近10轮对话
  if (context.length > MAX_CONTEXT_LENGTH) {
    context.shift();
  }
  
  // 清理过期上下文（1小时）
  const now = Date.now();
  while (context.length > 0 && now - context[0].timestamp > 3600000) {
    context.shift();
  }
  
  // M2-FIX: 限制总用户数，淘汰最旧的用户上下文
  if (_conversationContext.size > MAX_CONTEXT_USERS) {
    let oldestKey = null, oldestTime = Infinity;
    for (const [key, ctx] of _conversationContext.entries()) {
      const lastTs = ctx.length > 0 ? ctx[ctx.length - 1].timestamp : 0;
      if (lastTs < oldestTime) { oldestTime = lastTs; oldestKey = key; }
    }
    if (oldestKey) _conversationContext.delete(oldestKey);
  }
}

function getContext(userId) {
  return _conversationContext.get(userId) || [];
}

export async function callLLM(messages, options = {}) {
  const model = options.model || DEEPSEEK_MODEL;
  const apiKey = DEEPSEEK_API_KEY;
  if (!apiKey) return { ok: false, error: 'no_api_key', content: '' };
  
  // 生成缓存键
  const cacheKey = `${model}:${JSON.stringify(messages.slice(-2))}:${options.temperature || 0.1}`;
  
  // 检查缓存
  const cachedResponse = getCachedResponse(cacheKey);
  if (cachedResponse && !options.skipCache) {
    return { ok: true, content: cachedResponse, cached: true };
  }
  
  const startTime = Date.now();
  _performanceMetrics.totalCalls++;
  
  try {
    const resp = await axios.post(
      `${DEEPSEEK_BASE_URL}/chat/completions`,
      { 
        model, 
        messages, 
        temperature: options.temperature ?? 0.1,  // 降低温度提高一致性
        max_tokens: options.max_tokens ?? 1500,  // 控制输出长度
        top_p: 0.9,  // 增加top_p控制
        frequency_penalty: 0.1,  // 减少重复
        presence_penalty: 0.1
      },
      { headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, timeout: 60000 }
    );
    
    const content = resp.data?.choices?.[0]?.message?.content || '';
    const responseTime = Date.now() - startTime;
    
    // 更新性能指标
    _performanceMetrics.avgResponseTime = 
      (_performanceMetrics.avgResponseTime * (_performanceMetrics.totalCalls - 1) + responseTime) / 
      _performanceMetrics.totalCalls;
    
    // 缓存响应
    if (!options.skipCache && content) {
      setCachedResponse(cacheKey, content);
    }
    
    return { ok: true, content, raw: resp.data, responseTime };
  } catch (e) {
    _performanceMetrics.errorCount++;
    console.error('[agents] callLLM error:', e?.message || e);
    return { ok: false, error: String(e?.message || e), content: '' };
  }
}

export async function callVisionLLM(imageUrl, prompt) {
  const apiKey = DEEPSEEK_API_KEY;
  if (!apiKey) return { ok: false, error: 'no_api_key', content: '' };
  try {
    let imageContent;
    if (imageUrl.startsWith('data:') || imageUrl.startsWith('http')) {
      imageContent = { type: 'image_url', image_url: { url: imageUrl } };
    } else {
      const buf = fs.readFileSync(imageUrl);
      const b64 = buf.toString('base64');
      const ext = path.extname(imageUrl).replace('.', '') || 'jpeg';
      imageContent = { type: 'image_url', image_url: { url: `data:image/${ext};base64,${b64}` } };
    }
    const resp = await axios.post(
      `${DEEPSEEK_BASE_URL}/chat/completions`,
      {
        model: DEEPSEEK_VISION_MODEL,
        messages: [{ role: 'user', content: [imageContent, { type: 'text', text: prompt }] }],
        temperature: 0.2, max_tokens: 1500
      },
      { headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, timeout: 90000 }
    );
    return { ok: true, content: resp.data?.choices?.[0]?.message?.content || '', raw: resp.data };
  } catch (e) {
    console.error('[agents] callVisionLLM error:', e?.message || e);
    return { ok: false, error: String(e?.message || e), content: '' };
  }
}

export async function queryKnowledgeBase(agent, query, limit = 5, options = {}) {
  try {
    const brandTag = String(options?.brandTag || '').trim();
    const r = await pool().query(
      `SELECT title, content, tags, created_at 
       FROM knowledge_base 
       WHERE ($1 = '' OR tags && $1) 
         AND (content ILIKE $2 OR title ILIKE $2)
       ORDER BY created_at DESC 
       LIMIT $3`,
      [brandTag, `%${query}%`, limit]
    );
    return r.rows || [];
  } catch (e) {
    console.error('[agents] queryKnowledgeBase error:', e?.message);
    return [];
  }
}

// Query Bitable data for all agents
export async function queryBitableData(agent, query, limit = 10, options = {}) {
  try {
    const contentType = options?.contentType || '';
    const configKey = options?.configKey || '';
    
    let whereClause = `content_type IN ('bitable_submission', 'table_visit', 'vision_analysis')`;
    let params = [`%${query}%`, limit];
    
    if (contentType) {
      whereClause += ` AND content_type = $${params.length + 1}`;
      params.push(contentType);
    }
    
    if (configKey) {
      whereClause += ` AND agent_data::text ILIKE $${params.length + 1}`;
      params.push(`%"configKey":"${configKey}"%`);
    }
    
    const r = await pool().query(
      `SELECT content, content_type, agent_data, created_at, sender_name
       FROM agent_messages 
       WHERE ${whereClause} 
         AND (content ILIKE $1 OR agent_data::text ILIKE $1)
       ORDER BY created_at DESC 
       LIMIT $2`,
      params
    );
    
    return r.rows || [];
  } catch (e) {
    console.error('[agents] queryBitableData error:', e?.message);
    return [];
  }
}

// Unified query function for all agents
export async function queryAgentData(agent, query, limit = 10, options = {}) {
  const includeBitable = options?.includeBitable !== false;
  const includeKnowledge = options?.includeKnowledge !== false;
  
  const results = {
    knowledge: [],
    bitable: []
  };
  
  if (includeKnowledge) {
    results.knowledge = await queryKnowledgeBase(agent, query, limit, options);
  }
  
  if (includeBitable) {
    results.bitable = await queryBitableData(agent, query, limit, options);
  }
  
  return results;
}

// ─────────────────────────────────────────────
// 3. Shared State Helpers
// ─────────────────────────────────────────────

export async function getSharedState() {
  const r = await pool().query('SELECT data FROM hrms_state WHERE key = $1 LIMIT 1', ['default']);
  return r.rows?.[0]?.data && typeof r.rows[0].data === 'object' ? r.rows[0].data : {};
}

function findUserInState(state, username) {
  const u = String(username || '').trim().toLowerCase();
  if (!u) return null;
  const all = [
    ...(Array.isArray(state?.employees) ? state.employees : []),
    ...(Array.isArray(state?.users) ? state.users : [])
  ];
  return all.find(x => String(x?.username || '').trim().toLowerCase() === u) || null;
}

export function getStoresFromState(state) {
  const stores = Array.isArray(state?.stores) ? state.stores : [];
  return stores.map(s => ({
    id: String(s?.id || '').trim(),
    name: String(s?.name || '').trim(),
    brand: String(s?.brand || s?.brandName || '').trim(),
    brandId: normalizeBrandId(s?.brandId || s?.brand || s?.brandName)
  })).filter(s => s.name);
}

export function inferBrandFromStoreName(storeName) {
  const s = String(storeName || '').trim();
  if (s.includes('马己仙')) return '马己仙';
  if (s.includes('洪潮')) return '洪潮';
  return '';
}

function resolveBrand(state, store) {
  const ctx = resolveBrandContextByStore(state, store);
  return ctx?.brandName || inferBrandFromStoreName(store) || '洪潮';
}

export async function findStoreManager(state, storeName) {
  const all = [
    ...(Array.isArray(state?.employees) ? state.employees : []),
    ...(Array.isArray(state?.users) ? state.users : [])
  ];
  const mgr = all.find(u =>
    String(u?.store || '').trim() === storeName &&
    String(u?.role || '').trim() === 'store_manager'
  );
  return mgr ? String(mgr.username || '').trim() : null;
}

function toNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function toDateOnly(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  try {
    const d = new Date(s);
    if (!Number.isFinite(d.getTime())) return '';
    return d.toISOString().slice(0, 10);
  } catch (e) {
    return '';
  }
}

function inDateRangeInclusive(v, start, end) {
  const d = toDateOnly(v);
  if (!d) return false;
  const s = toDateOnly(start);
  const e = toDateOnly(end);
  if (s && d < s) return false;
  if (e && d > e) return false;
  return true;
}

function normProductKey(v) {
  return String(v || '').trim().toLowerCase().replace(/\s+/g, '');
}

function getMonthlyTarget(state, ym, store) {
  const settings = state?.settings && typeof state.settings === 'object' ? state.settings : {};
  const monthlyTargets = Array.isArray(settings?.monthlyTargets)
    ? settings.monthlyTargets
    : (Array.isArray(state?.monthlyTargets) ? state.monthlyTargets : []);
  return monthlyTargets.find((x) =>
    String(x?.ym || x?.month || '').trim() === ym &&
    String(x?.store || '').trim() === String(store || '').trim()
  ) || null;
}

function getActualRevenueFromHistoryRow(row) {
  const actual = Math.max(0, toNum(row?.actualRevenue, 0));
  if (actual > 0) return actual;
  const expected = Math.max(0, toNum(row?.expectedRevenue, 0));
  const discount = Math.max(0, toNum(row?.totalDiscount, 0));
  return Math.max(0, expected - discount);
}

function daysInMonth(dateStr) {
  const d = toDateOnly(dateStr);
  if (!d) return 30;
  const y = Number(d.slice(0, 4));
  const m = Number(d.slice(5, 7));
  if (!Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12) return 30;
  return new Date(y, m, 0).getDate();
}

function isConsecutiveDate(prevDate, currDate) {
  const p = toDateOnly(prevDate);
  const c = toDateOnly(currDate);
  if (!p || !c) return false;
  const d1 = new Date(`${p}T00:00:00`).getTime();
  const d2 = new Date(`${c}T00:00:00`).getTime();
  if (!Number.isFinite(d1) || !Number.isFinite(d2)) return false;
  return (d2 - d1) === 86400000;
}

function buildGrossProfileMap(profiles, store) {
  const map = new Map();
  (Array.isArray(profiles) ? profiles : [])
    .filter((x) => String(x?.store || '').trim() === String(store || '').trim())
    .forEach((x) => {
      const bizType = String(x?.bizType || '').trim().toLowerCase();
      const productKey = normProductKey(x?.product);
      if (!productKey) return;
      const key = `${bizType}||${productKey}`;
      map.set(key, {
        costPerUnit: toNum(x?.costPerUnit ?? x?.cost, NaN),
        grossPerUnit: toNum(x?.grossPerUnit ?? x?.grossProfit ?? x?.profitPerUnit, NaN)
      });
      if (bizType) {
        map.set(`||${productKey}`, {
          costPerUnit: toNum(x?.costPerUnit ?? x?.cost, NaN),
          grossPerUnit: toNum(x?.grossPerUnit ?? x?.grossProfit ?? x?.profitPerUnit, NaN)
        });
      }
    });
  return map;
}

function estimateMarginMetricsForRange({ state, store, startDate, endDate }) {
  const historyRows = (Array.isArray(state?.inventoryForecastHistory) ? state.inventoryForecastHistory : [])
    .filter((x) => String(x?.store || '').trim() === String(store || '').trim())
    .filter((x) => inDateRangeInclusive(x?.date, startDate, endDate));
  const profiles = Array.isArray(state?.forecastGrossProfitProfiles) ? state.forecastGrossProfitProfiles : [];
  const profileMap = buildGrossProfileMap(profiles, store);

  const out = {
    takeaway: { actualRevenue: 0, estimatedCost: 0, marginRate: 0 },
    dinein: { actualRevenue: 0, estimatedCost: 0, marginRate: 0 },
    total: { actualRevenue: 0, estimatedCost: 0, marginRate: 0 }
  };

  for (const row of historyRows) {
    const bizTypeRaw = String(row?.bizType || '').trim().toLowerCase();
    const bizType = bizTypeRaw === 'takeaway' || bizTypeRaw === 'delivery' || bizTypeRaw === '外卖'
      ? 'takeaway'
      : (bizTypeRaw === 'dinein' || bizTypeRaw === 'dine_in' || bizTypeRaw === '堂食' ? 'dinein' : '');
    if (!bizType) continue;

    const actualRevenue = getActualRevenueFromHistoryRow(row);
    out[bizType].actualRevenue += actualRevenue;
    out.total.actualRevenue += actualRevenue;

    const products = row?.productQuantities && typeof row.productQuantities === 'object' ? row.productQuantities : {};
    const entries = Object.entries(products)
      .map(([name, qtyRaw]) => ({ name, qty: toNum(qtyRaw, 0) }))
      .filter((x) => x.qty > 0);
    const totalQty = entries.reduce((s, x) => s + x.qty, 0);
    if (!totalQty) continue;

    const expectedRevenue = Math.max(0, toNum(row?.expectedRevenue, 0));
    for (const entry of entries) {
      const key = normProductKey(entry.name);
      if (!key) continue;
      const profile = profileMap.get(`${bizType}||${key}`) || profileMap.get(`||${key}`) || null;
      if (!profile) continue;

      let estimatedCost = 0;
      if (Number.isFinite(profile.costPerUnit) && profile.costPerUnit >= 0) {
        estimatedCost = entry.qty * profile.costPerUnit;
      } else if (Number.isFinite(profile.grossPerUnit) && profile.grossPerUnit >= 0 && expectedRevenue > 0) {
        const allocRevenue = (entry.qty / totalQty) * expectedRevenue;
        estimatedCost = Math.max(0, allocRevenue - entry.qty * profile.grossPerUnit);
      }

      out[bizType].estimatedCost += estimatedCost;
      out.total.estimatedCost += estimatedCost;
    }
  }

  const calcRate = (actualRevenue, estimatedCost) => {
    if (!(actualRevenue > 0)) return 0;
    return Math.max(0, 1 - (estimatedCost / actualRevenue));
  };

  out.takeaway.marginRate = calcRate(out.takeaway.actualRevenue, out.takeaway.estimatedCost);
  out.dinein.marginRate = calcRate(out.dinein.actualRevenue, out.dinein.estimatedCost);
  out.total.marginRate = calcRate(out.total.actualRevenue, out.total.estimatedCost);

  return out;
}

async function loadTableVisitMetricsByStore(store, startDate, endDate) {
  const out = {
    countByDate: new Map(),
    dissatisfiedProducts: new Map(),
    dissatisfiedByDate: new Map()
  };
  try {
    const r = await pool().query(
      `SELECT date::text AS date, dissatisfaction_dish
       FROM table_visit_records
       WHERE store = $1 AND date >= $2::date AND date <= $3::date`,
      [store, startDate, endDate]
    );

    for (const row of (r.rows || [])) {
      const d = toDateOnly(row?.date);
      if (!d) continue;
      out.countByDate.set(d, (out.countByDate.get(d) || 0) + 1);

      const rawDish = String(row?.dissatisfaction_dish || '').trim();
      if (!rawDish) continue;
      rawDish
        .split(/[，,、\/\s]+/)
        .map((x) => String(x || '').trim())
        .filter(Boolean)
        .forEach((product) => {
          const key = `${store}||${product}`;
          out.dissatisfiedProducts.set(key, (out.dissatisfiedProducts.get(key) || 0) + 1);
          const dateSet = out.dissatisfiedByDate.get(d) || new Set();
          dateSet.add(product);
          out.dissatisfiedByDate.set(d, dateSet);
        });
    }
  } catch (e) {
    // table may not exist in some envs; keep auditor running
  }
  return out;
}

// ─────────────────────────────────────────────
// 4. Feishu Client
// ─────────────────────────────────────────────

let _larkTenantToken = null;
let _larkTenantTokenExpires = 0;
let _bitableTenantTokens = new Map(); // 支持多个配置的 token

// 获取飞书租户token
async function getLarkTenantToken() {
  // 检查缓存的token
  if (_larkTenantToken && Date.now() < _larkTenantTokenExpires) {
    return _larkTenantToken;
  }
  
  try {
    const resp = await axios.post('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
      app_id: LARK_APP_ID,
      app_secret: LARK_APP_SECRET
    }, { timeout: 10000 });
    
    const token = resp.data?.tenant_access_token || '';
    const expires = Date.now() + (resp.data?.expire || 7000) * 1000;
    
    _larkTenantToken = token;
    _larkTenantTokenExpires = expires;
    
    console.log('[feishu] tenant token refreshed, expires in', resp.data?.expire, 's');
    return token;
  } catch (e) {
    console.error('[feishu] get tenant token failed:', e?.message);
    return '';
  }
}

async function getBitableTenantToken(configKey = 'ops_checklist') {
  const config = BITABLE_CONFIGS[configKey];
  if (!config) {
    console.error(`[bitable] invalid config key: ${configKey}`);
    return '';
  }
  
  // 检查缓存的 token
  const cached = _bitableTenantTokens.get(configKey);
  if (cached && Date.now() < cached.expires) {
    return cached.token;
  }
  
  try {
    const resp = await axios.post('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
      app_id: config.appId, app_secret: config.appSecret
    }, { timeout: 10000 });
    
    const token = resp.data?.tenant_access_token || '';
    const expires = Date.now() + (resp.data?.expire || 7000) * 1000;
    
    _bitableTenantTokens.set(configKey, { token, expires });
    console.log(`[bitable][${configKey}] tenant token refreshed, expires in`, resp.data?.expire, 's');
    return token;
  } catch (e) {
    console.error(`[bitable][${configKey}] get tenant token failed:`, e?.message);
    return '';
  }
}

// ─────────────────────────────────────────────
// Bitable API Client
// ─────────────────────────────────────────────

export async function getBitableRecords(configKey = 'ops_checklist', options = {}) {
  const config = BITABLE_CONFIGS[configKey];
  if (!config) {
    console.error(`[bitable] invalid config key: ${configKey}`);
    return { ok: false, error: 'invalid_config' };
  }
  
  const token = await getBitableTenantToken(configKey);
  if (!token) {
    console.error(`[bitable][${configKey}] cannot get records: no token`);
    return { ok: false, error: 'no_token' };
  }

  const { pageSize = 20, pageToken, filter, sort = [] } = options;
  const params = {
    page_size: pageSize,
    user_id_type: 'open_id'
  };
  
  if (pageToken) params.page_token = pageToken;
  if (filter) params.filter = filter;
  if (sort.length > 0) params.sort = JSON.stringify(sort);

  try {
    const resp = await axios.get(
      `https://open.feishu.cn/open-apis/bitable/v1/apps/${config.appToken}/tables/${config.tableId}/records`,
      {
        headers: { 'Authorization': `Bearer ${token}` },
        params,
        timeout: 15000
      }
    );

    const records = resp.data?.data?.items || [];
    const hasMore = resp.data?.data?.has_more || false;
    const nextPageToken = resp.data?.data?.page_token || '';
    const total = resp.data?.data?.total || 0;

    return { ok: true, records, hasMore, nextPageToken, total };
  } catch (e) {
    console.error('[bitable] get records failed:', e?.response?.data || e?.message);
    return { ok: false, error: String(e?.message || e) };
  }
}

export async function getBitableRecordImageDownloadUrl(configKey = 'ops_checklist', fileToken) {
  const token = await getBitableTenantToken();
  if (!token) {
    console.error('[bitable] cannot get image url: no token');
    return null;
  }

  try {
    // 方法1：使用 drive API 获取下载链接
    const resp = await axios.get(
      `https://open.feishu.cn/open-apis/drive/v1/files/${fileToken}/download_url`,
      {
        headers: { 'Authorization': `Bearer ${token}` },
        timeout: 10000
      }
    );

    const downloadUrl = resp.data?.data?.download_url || '';
    if (downloadUrl) {
      console.log('[bitable] got image download url for token:', fileToken);
      return downloadUrl;
    }
    return null;
  } catch (e) {
    console.error('[bitable] get image download url failed:', e?.response?.data || e?.message);
    
    // 方法2：尝试使用 media API
    try {
      const mediaResp = await axios.get(
        `https://open.feishu.cn/open-apis/drive/v1/medias/${fileToken}/download`,
        {
          headers: { 'Authorization': `Bearer ${token}` },
          timeout: 10000
        }
      );
      
      if (mediaResp.data) {
        console.log('[bitable] got media download for token:', fileToken);
        // 直接返回图片数据或临时URL
        return `data:image/jpeg;base64,${Buffer.from(mediaResp.data).toString('base64')}`;
      }
    } catch (e2) {
      console.error('[bitable] media download also failed:', e2?.response?.data || e2?.message);
    }
    
    return null;
  }
}

// 桌访数据处理
async function processTableVisitData(records) {
  console.log(`[table_visit] processing ${records.length} records`);
  
  for (const record of records) {
    const fields = record.fields || {};
    
    // 解析桌访数据（根据实际字段调整）
    const tableVisitData = {
      recordId: record.record_id,
      createdTime: record.created_time,
      date: fields['日期'] || '',
      store: fields['所属门店'] || '',
      brand: fields['所属品牌'] || '',
      tableNumber: fields['桌号'] || '',
      customerCount: fields['就餐人数'] || fields['人数'] || 0,
      consumption: fields['消费金额'] || 0,
      hasReservation: fields['是否有预订'] || '',
      dissatisfactionDish: fields['今日不满意菜品'] || '',
      remarks: fields['备注'] || '',
      submitter: fields['提交人'] || '',
      fields
    };
    
    console.log(`[table_visit] new record:`, tableVisitData);
    
    // 存储到数据库
    try {
      await pool().query(`
        INSERT INTO agent_messages (direction, channel, feishu_open_id, sender_username, sender_name, sender_role, routed_to, content_type, content, agent_data, record_id)
        VALUES ('in','feishu',$1,$2,$3,$4,'ops_supervisor','table_visit',$5,$6::jsonb,$7)
      `, [
        tableVisitData.submitter?.id || '',
        tableVisitData.submitter?.name || '',
        tableVisitData.submitter?.name || '',
        'table_visit_submitter',
        `桌访数据提交 - ${tableVisitData.store} 桌${tableVisitData.tableNumber}`,
        JSON.stringify(tableVisitData),
        tableVisitData.recordId
      ]);
      
      console.log(`[table_visit] saved record: ${tableVisitData.recordId}`);
    } catch (e) {
      // 忽略重复记录错误
      if (!e?.message?.includes('duplicate')) {
        console.error(`[table_visit] save failed for ${tableVisitData.recordId}:`, e?.message);
      }
    }
  }
}

// 检查表数据处理（保持原有逻辑）
async function processChecklistData(records) {
  console.log(`[checklist] processing ${records.length} records`);
  // ... 原有的检查表处理逻辑
}

// 根据配置类型处理数据
export async function processBitableData(configKey, records) {
  const config = BITABLE_CONFIGS[configKey];
  if (!config) {
    console.error(`[bitable] invalid config key: ${configKey}`);
    return;
  }
  
  switch (config.type) {
    case 'checklist':
      return await processChecklistData(records);
    case 'table_visit':
      return await processTableVisitData(records);
    case 'closing_report':
      return await processClosingReportData(records);
    case 'opening_report':
      return await processOpeningReportData(records);
    case 'meeting_report':
      return await processMeetingReportData(records);
    case 'material_report':
      return await processMaterialReportData(records, config.brand);
    default:
      console.log(`[bitable][${configKey}] unknown type: ${config.type}, processing as generic`);
      return await processGenericData(records, configKey);
  }
}

// 通用数据处理
async function processGenericData(records, configKey) {
  for (const record of records) {
    console.log(`[bitable][${configKey}] generic record:`, record.record_id);
    
    try {
      await pool().query(`
        INSERT INTO agent_messages (direction, channel, content_type, content, agent_data)
        VALUES ('in','feishu','generic_bitable',$1,$2::jsonb)
        ON CONFLICT (record_id) DO UPDATE SET
          content = EXCLUDED.content,
          agent_data = EXCLUDED.agent_data,
          updated_at = NOW()
      `, [
        `通用数据 - ${configKey}`,
        JSON.stringify({ configKey, recordId: record.record_id, fields: record.fields })
      ]);
    } catch (e) {
      console.error(`[bitable][${configKey}] save generic record failed:`, e?.message);
    }
  }
}

// 收档报告数据处理
async function processClosingReportData(records) {
  for (const record of records) {
    console.log(`[bitable] closing report record:`, record.record_id);
    
    try {
      const fields = record.fields || {};
      await pool().query(`
        INSERT INTO agent_messages (direction, channel, content_type, content, agent_data)
        VALUES ('in','feishu','closing_report',$1,$2::jsonb)
        ON CONFLICT (record_id) DO UPDATE SET
          content = EXCLUDED.content,
          agent_data = EXCLUDED.agent_data,
          updated_at = CURRENT_TIMESTAMP
      `, [
        '收档报告',
        JSON.stringify({ 
          type: 'closing_report', 
          recordId: record.record_id, 
          fields: {
            store: fields['门店'],
            date: fields['日期'],
            station: fields['档口'],
            responsible: fields['本档口值班负责人'],
            handover_time: fields['交接时间'],
            inventory_check: fields['本档口库存检查'],
            cleaning_status: fields['本档口清洁卫生'],
            equipment_status: fields['设备使用情况'],
            temperature_record: fields['温度记录'],
            handover_person: fields['交接人'],
            handover_receiver: fields['接收人'],
            issues: fields['异常情况说明'],
            submit_time: fields['提交时间']
          }
        })
      ]);
    } catch (e) {
      console.error(`[bitable] save closing report record failed:`, e?.message);
    }
  }
}

// 开档报告数据处理
async function processOpeningReportData(records) {
  for (const record of records) {
    console.log(`[bitable] opening report record:`, record.record_id);
    
    try {
      const fields = record.fields || {};
      await pool().query(`
        INSERT INTO agent_messages (direction, channel, content_type, content, agent_data)
        VALUES ('in','feishu','opening_report',$1,$2::jsonb)
        ON CONFLICT (record_id) DO UPDATE SET
          content = EXCLUDED.content,
          agent_data = EXCLUDED.agent_data,
          updated_at = CURRENT_TIMESTAMP
      `, [
        '开档报告',
        JSON.stringify({ 
          type: 'opening_report', 
          recordId: record.record_id, 
          fields: {
            store: fields['门店'],
            date: fields['日期'],
            station: fields['档口'],
            responsible: fields['本档口值班负责人'],
            preparation_time: fields['开档时间'],
            inventory_check: fields['本档口库存检查'],
            cleaning_status: fields['本档口清洁卫生'],
            equipment_status: fields['设备使用情况'],
            temperature_check: fields['温度检查'],
            staff_ready: fields['人员准备情况'],
            issues: fields['异常情况说明'],
            submit_time: fields['提交时间']
          }
        })
      ]);
    } catch (e) {
      console.error(`[bitable] save opening report record failed:`, e?.message);
    }
  }
}

// 例会报告数据处理
async function processMeetingReportData(records) {
  for (const record of records) {
    console.log(`[bitable] meeting report record:`, record.record_id);
    
    try {
      const fields = record.fields || {};
      await pool().query(`
        INSERT INTO agent_messages (direction, channel, content_type, content, agent_data)
        VALUES ('in','feishu','meeting_report',$1,$2::jsonb)
        ON CONFLICT (record_id) DO UPDATE SET
          content = EXCLUDED.content,
          agent_data = EXCLUDED.agent_data,
          updated_at = CURRENT_TIMESTAMP
      `, [
        '例会报告',
        JSON.stringify({ 
          type: 'meeting_report', 
          recordId: record.record_id, 
          fields: {
            store: fields['门店'],
            date: fields['日期'],
            meeting_type: fields['会议类型'],
            organizer: fields['组织人'],
            participants: fields['参会人员'],
            meeting_time: fields['会议时间'],
            duration: fields['会议时长'],
            topics: fields['会议议题'],
            decisions: fields['决议事项'],
            action_items: fields['行动项'],
            next_meeting: fields['下次会议时间'],
            submit_time: fields['提交时间']
          }
        })
      ]);
    } catch (e) {
      console.error(`[bitable] save meeting report record failed:`, e?.message);
    }
  }
}

// 原料收货报告数据处理
async function processMaterialReportData(records, brand) {
  for (const record of records) {
    console.log(`[bitable] material report record (${brand}):`, record.record_id);
    
    try {
      const fields = record.fields || {};
      await pool().query(`
        INSERT INTO agent_messages (direction, channel, content_type, content, agent_data)
        VALUES ('in','feishu','material_report',$1,$2::jsonb)
        ON CONFLICT (record_id) DO UPDATE SET
          content = EXCLUDED.content,
          agent_data = EXCLUDED.agent_data,
          updated_at = CURRENT_TIMESTAMP
      `, [
        `${brand}原料收货日报`,
        JSON.stringify({ 
          type: 'material_report', 
          recordId: record.record_id, 
          brand: brand,
          fields: {
            store: fields['门店'],
            date: fields['日期'],
            material_name: fields['原料名称'],
            supplier: fields['供应商'],
            quantity: fields['数量'],
            unit: fields['单位'],
            unit_price: fields['单价'],
            total_price: fields['总价'],
            quality_check: fields['质量检查'],
            storage_location: fields['存储位置'],
            receiver: fields['收货人'],
            delivery_person: fields['送货人'],
            notes: fields['备注'],
            submit_time: fields['提交时间']
          }
        })
      ]);
    } catch (e) {
      console.error(`[bitable] save material report record failed:`, e?.message);
    }
  }
}

const _bitableArchiveThresholdDays = 7; // 7天后归档（更激进）
const _bitableDeleteThresholdDays = 60; // 60天后删除（2个月）

export async function archiveOldBitableSubmissions() {
  console.log('[bitable] starting data archive process...');
  
  try {
    // 1. 创建归档表（如果不存在）
    await pool().query(`
      CREATE TABLE IF NOT EXISTS bitable_submissions_archive (
        LIKE agent_messages INCLUDING ALL
      )
    `);
    
    // 2. 查找需要归档的记录
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - _bitableArchiveThresholdDays);
    
    const oldRecords = await pool().query(`
      SELECT * FROM agent_messages 
      WHERE content_type = 'bitable_submission' 
        AND created_at < $1
        AND record_id NOT IN (SELECT record_id FROM bitable_submissions_archive)
      ORDER BY created_at ASC
    `, [cutoffDate.toISOString()]);
    
    if (oldRecords.rows.length === 0) {
      console.log('[bitable] no records to archive');
      return { archived: 0, deleted: 0 };
    }
    
    console.log(`[bitable] found ${oldRecords.rows.length} records to archive`);
    
    // 3. 移动到归档表
    let archivedCount = 0;
    for (const record of oldRecords.rows) {
      try {
        await pool().query(`
          INSERT INTO bitable_submissions_archive (
            id, direction, channel, feishu_open_id, sender_username, sender_name, 
            sender_role, routed_to, content_type, content, agent_data, 
            created_at, updated_at, feishu_message_id, image_urls
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
        `, [
          record.id, record.direction, record.channel, record.feishu_open_id,
          record.sender_username, record.sender_name, record.sender_role,
          record.routed_to, record.content_type, record.content, record.agent_data,
          record.created_at, record.updated_at, record.feishu_message_id,
          record.image_urls
        ]);
        
        // 删除原记录
        await pool().query('DELETE FROM agent_messages WHERE id = $1', [record.id]);
        archivedCount++;
      } catch (e) {
        console.error(`[bitable] failed to archive record ${record.id}:`, e?.message);
      }
    }
    
    // 4. 删除超过删除阈值的记录
    const deleteCutoffDate = new Date();
    deleteCutoffDate.setDate(deleteCutoffDate.getDate() - _bitableDeleteThresholdDays);
    
    const deleteResult = await pool().query(`
      DELETE FROM bitable_submissions_archive 
      WHERE created_at < $1
    `, [deleteCutoffDate.toISOString()]);
    
    const deletedCount = deleteResult.rowCount || 0;
    
    console.log(`[bitable] archive completed: ${archivedCount} archived, ${deletedCount} deleted`);
    
    return { archived: archivedCount, deleted: deletedCount };
    
  } catch (e) {
    console.error('[bitable] archive process failed:', e?.message);
    return { archived: 0, deleted: 0, error: String(e?.message) };
  }
}

export async function getBitableSubmissionStats() {
  try {
    // 主表统计
    const mainStats = await pool().query(`
      SELECT 
        COUNT(*) as total,
        COUNT(CASE WHEN created_at > NOW() - INTERVAL '7 days' THEN 1 END) as last_7_days,
        COUNT(CASE WHEN created_at > NOW() - INTERVAL '30 days' THEN 1 END) as last_30_days,
        MIN(created_at) as oldest,
        MAX(created_at) as newest
      FROM agent_messages 
      WHERE content_type = 'bitable_submission'
    `);
    
    // 归档表统计
    const archiveStats = await pool().query(`
      SELECT 
        COUNT(*) as total,
        COUNT(CASE WHEN created_at > NOW() - INTERVAL '30 days' THEN 1 END) as last_30_days
      FROM bitable_submissions_archive
    `);
    
    return {
      main: mainStats.rows[0] || {},
      archive: archiveStats.rows[0] || {},
      total: (mainStats.rows[0]?.total || 0) + (archiveStats.rows[0]?.total || 0)
    };
  } catch (e) {
    console.error('[bitable] get stats failed:', e?.message);
    return { main: {}, archive: {}, total: 0 };
  }
}

// ─────────────────────────────────────────────
// Bitable Integration for Checklist (continued)

const _bitableLastProcessedTime = new Map();
const _bitableProcessedRecordIds = new Set();

export async function pollBitableSubmissions(configKey = 'ops_checklist') {
  console.log(`[bitable][${configKey}] polling submissions...`);
  
  const result = await getBitableRecords(configKey);
  if (!result.ok) {
    console.error(`[bitable][${configKey}] poll failed:`, result.error);
    return;
  }
  
  const records = result.records || [];
  const newSubmissions = [];
  
  for (const record of records) {
    const recordId = record.record_id;
    const createdTime = record.created_time;
    const fields = record.fields || {};
    
    // 检查是否已处理过（使用 recordId 去重）
    const processedKey = `${configKey}_${recordId}`;
    if (_bitableProcessedRecordIds.has(processedKey)) {
      continue;
    }
    
    // 解析表单数据
    const submission = {
      configKey,
      recordId,
      createdTime,
      submitter: fields['提交人'] || '',
      store: fields['所属门店'] || '',
      checkType: fields['检查类型'] || '',
      checkStatus: fields['检查状态'] || '',
      checkRemark: fields['检查说明'] || '',
      checkPhotos: fields['检查照片'] || [],
      submitTime: fields['提交日期'] || createdTime,
      fields
    };
    
    console.log(`[bitable][${configKey}] new submission:`, submission);
    newSubmissions.push(submission);
    
    // 标记为已处理
    _bitableProcessedRecordIds.add(processedKey);
    _bitableLastProcessedTime.set(processedKey, createdTime);
    
    // 限制内存中的记录数量
    if (_bitableProcessedRecordIds.size > 1000) {
      const oldestIds = Array.from(_bitableProcessedRecordIds).slice(0, 500);
      oldestIds.forEach(id => {
        _bitableProcessedRecordIds.delete(id);
        _bitableLastProcessedTime.delete(id);
      });
      console.log('[bitable] cleaned up old processed records, current size:', _bitableProcessedRecordIds.size);
    }
  }
  
  if (newSubmissions.length > 0) {
    console.log(`[bitable][${configKey}] processed ${newSubmissions.length} new submissions`);
    
    // 处理数据（根据配置类型）
    await processBitableData(configKey, records);
    
    // 如果是检查表类型，继续原有的确认消息逻辑
    if (configKey === 'ops_checklist') {
      // 处理每条提交记录
      for (const sub of newSubmissions) {
        // 1. 逻辑纠偏检查
        const logicValidation = await validateSubmissionLogic(sub);
        if (!logicValidation.isValid) {
          // 打回重拍
          if (sub.submitter && sub.submitter.id) {
            const rejectMessage = `❌ 提交被驳回\n${logicValidation.suggestion}\n请核实后重新提交。`;
            await sendLarkMessage(sub.submitter.id, prefixWithAgentName('ops_supervisor', rejectMessage));
            continue;
          }
        }
        
        // 2. 照片真实性验证
        let photoValidationResults = [];
        if (sub.checkPhotos && sub.checkPhotos.length > 0) {
          for (const photo of sub.checkPhotos) {
            if (photo.file_token) {
              const imageUrl = await getBitableRecordImageDownloadUrl(photo.file_token);
              if (imageUrl) {
                const validation = await validatePhotoAuthenticity(imageUrl, sub.store, sub.submitTime);
                photoValidationResults.push({
                  fileName: photo.name,
                  validation
                });
                
                // 如果照片不真实，直接拒绝
                if (!validation.isAuthentic) {
                  if (sub.submitter && sub.submitter.id) {
                    const rejectMessage = `🚫 照片验证失败\n检测到：${!validation.timeValid ? '时间异常' : ''}${!validation.notDuplicate ? '照片重复' : ''}${!validation.locationMatch ? '地点不符' : ''}\n请重新拍摄真实照片。`;
                    await sendLarkMessage(sub.submitter.id, prefixWithAgentName('ops_supervisor', rejectMessage));
                  }
                  continue;
                }
              }
            }
          }
        }
        
        // 3. 图片识别分析
        let visionResults = [];
        if (sub.checkPhotos && sub.checkPhotos.length > 0) {
          console.log(`[bitable] processing ${sub.checkPhotos.length} photos for record ${sub.recordId}`);
          
          for (const photo of sub.checkPhotos) {
            if (photo.file_token) {
              const imageUrl = await getBitableRecordImageDownloadUrl(photo.file_token);
              if (imageUrl) {
                try {
                  const visionResult = await callVisionLLM([
                    { type: 'image', image_url: imageUrl },
                    { type: 'text', text: `请检查这张餐厅${sub.checkType}照片，评估：1.卫生状况 2.安全规范 3.整体状态。给出评分(1-10分)和具体问题。` }
                  ]);
                  
                  visionResults.push({
                    fileName: photo.name,
                    result: visionResult.content || '识别失败',
                    score: extractScore(visionResult.content) || 0
                  });
                  
                  console.log(`[bitable] vision result for ${photo.name}:`, visionResult.content?.substring(0, 100) + '...');
                } catch (e) {
                  console.error(`[bitable] vision analysis failed for ${photo.file_token}:`, e?.message);
                  visionResults.push({
                    fileName: photo.name,
                    result: '图片识别失败',
                    score: 0
                  });
                }
              }
            }
          }
        }
        
        // 4. 构建确认消息
        let reply = `✅ 已收到你的${sub.checkType}提交\n门店：${sub.store}\n状态：${sub.checkStatus}\n说明：${sub.checkRemark}\n照片：${sub.checkPhotos.length}张\n提交时间：${new Date(sub.submitTime).toLocaleString()}\n`;
        
        // 添加照片验证结果
        if (photoValidationResults.length > 0) {
          reply += `\n🔍 照片验证：全部通过真实性检查`;
        }
        
        // 添加图片识别结果
        if (visionResults.length > 0) {
          const avgScore = visionResults.reduce((sum, r) => sum + r.score, 0) / visionResults.length;
          reply += `\n\n🎯 图片识别结果：\n平均评分：${avgScore.toFixed(1)}/10`;
          visionResults.forEach((r, i) => {
            reply += `\n${i + 1}. ${r.fileName}：${r.score}/10 - ${r.result.substring(0, 30)}...`;
          });
        }
        
        reply += `\n\n系统已记录，感谢配合！`;
        
        // 5. 存储识别结果到数据库（添加去重检查）
        try {
          const messageKey = `${sub.submitter.id}-${sub.recordId}-vision_analysis`;
          if (!deduplicateMessage(messageKey, 'system')) {
            console.log('[bitable] vision analysis message deduplicated');
          } else {
            await pool().query(
              `INSERT INTO agent_messages (direction, channel, feishu_open_id, sender_username, sender_name, sender_role, routed_to, content_type, content, agent_data)
               VALUES ('out','feishu',$1,$2,$3,$4,'ops_supervisor','vision_analysis',$5,$6::jsonb)`,
              [sub.submitter.id, sub.submitter.name || sub.submitter.id, sub.submitter.name || sub.submitter.id, '', 
               `${sub.checkType}图片识别分析`, JSON.stringify({ recordId: sub.recordId, visionResults, photoValidationResults, avgScore: visionResults.reduce((sum, r) => sum + r.score, 0) / visionResults.length })]
            );
          }
        } catch (e) {}
        
        // 6. 存储结构化数据到本地数据库
        try {
          await pool().query(
            `INSERT INTO agent_messages (direction, channel, feishu_open_id, sender_username, sender_name, sender_role, routed_to, content_type, content, agent_data)
             VALUES ('in','feishu',$1,$2,$3,$4,'ops_supervisor','bitable_submission',$5,$6::jsonb)`,
            [sub.submitter.id, sub.submitter.name || sub.submitter.id, sub.submitter.name || sub.submitter.id, '', 
             `${sub.checkType}提交（Bitable）`, JSON.stringify(submission)]
          );
        } catch (e) {}
        
        // 7. 发送确认消息
        await sendLarkMessage(sub.submitter.id, prefixWithAgentName('ops_supervisor', reply));
      }
    }
  }
}

// 多配置轮询调度器
export async function pollAllBitableSubmissions() {
  for (const [configKey, config] of Object.entries(BITABLE_CONFIGS)) {
    try {
      await pollBitableSubmissions(configKey);
    } catch (e) {
      console.error(`[bitable][${configKey}] poll error:`, e?.message);
    }
  }
}

// 导出定时任务函数
export { startScheduledTasks };

// ─────────────────────────────────────────────
// 定时任务调度器
// ─────────────────────────────────────────────

const SCHEDULED_TASKS = {
  '洪潮_开市': { time: '10:30', action: 'send_checklist', brand: '洪潮', checkType: 'opening' },
  '马己仙_收档': { time: '22:30', action: 'send_checklist', brand: '马己仙', checkType: 'closing' },
  '食安抽检': { random: true, interval: [2, 4], action: 'safety_check' }
};

let _scheduledTaskIntervals = new Map();

function startScheduledTasks() {
  console.log('[ops] starting scheduled tasks...');
  
  // 清除现有定时器
  for (const [key, interval] of _scheduledTaskIntervals) {
    clearInterval(interval);
  }
  _scheduledTaskIntervals.clear();
  
  // 设置定时任务
  for (const [taskKey, config] of Object.entries(SCHEDULED_TASKS)) {
    if (config.random) {
      // 随机任务
      scheduleRandomTask(taskKey, config);
    } else {
      // 定时任务
      scheduleFixedTask(taskKey, config);
    }
  }
}

function scheduleFixedTask(taskKey, config) {
  const [hour, minute] = config.time.split(':').map(Number);
  
  const scheduleNext = () => {
    const now = new Date();
    const nextExecution = new Date(now);
    nextExecution.setHours(hour);
    nextExecution.setMinutes(minute);
    
    // 如果今天的时间已过，安排到明天
    if (nextExecution <= now) {
      nextExecution.setDate(nextExecution.getDate() + 1);
    }
    
    const msUntilExecution = nextExecution.getTime() - now.getTime();
    
    setTimeout(() => {
      executeScheduledTask(taskKey, config);
      scheduleNextTask(); // 递归调度下一次
    }, msUntilExecution);
    
    console.log(`[ops] scheduled ${taskKey} for: ${nextExecution.toISOString()}`);
  };
  
  scheduleNext();
}

function scheduleRandomTask(taskKey, config) {
  const [minHours, maxHours] = config.interval;
  
  const scheduleNext = () => {
    // 随机间隔：2-4小时
    const intervalHours = Math.floor(Math.random() * (maxHours - minHours + 1)) + minHours;
    const intervalMs = intervalHours * 60 * 60 * 1000;
    
    setTimeout(() => {
      executeScheduledTask(taskKey, config);
      scheduleNextTask(); // 递归调度下一次
    }, intervalMs);
    
    const nextExecution = new Date(Date.now() + intervalMs);
    console.log(`[ops] scheduled random ${taskKey} for: ${nextExecution.toISOString()} (interval: ${intervalHours}h)`);
  };
  
  scheduleNext();
}

async function executeScheduledTask(taskKey, config) {
  console.log(`[ops] executing scheduled task: ${taskKey}`);
  
  try {
    switch (config.action) {
      case 'send_checklist':
        await sendScheduledChecklist(config);
        break;
      case 'safety_check':
        await sendSafetyCheck(config);
        break;
      default:
        console.log(`[ops] unknown task action: ${config.action}`);
    }
  } catch (e) {
    console.error(`[ops] scheduled task ${taskKey} failed:`, e?.message);
  }
}

export async function sendScheduledChecklist(config) {
  // 查找对应品牌的门店
  const sharedState = await getSharedState();
  const stores = Object.entries(sharedState.stores || {});
  const brandStores = stores.filter(([key, store]) => store.brand === config.brand);
  
  if (brandStores.length === 0) {
    console.log(`[ops] no stores found for brand: ${config.brand}`);
    return;
  }
  
  // 提取所有员工信息以寻找店长和出品经理
  const allStaff = [
    ...(Array.isArray(sharedState.employees) ? sharedState.employees : []),
    ...(Array.isArray(sharedState.users) ? sharedState.users : [])
  ];

  // 向每个门店发送检查表
  for (const [storeKey, store] of brandStores) {
    try {
      // 同时查找该门店的 店长(store_manager) 和 出品经理(store_production_manager)
      const targets = allStaff.filter(u =>
        String(u?.store || '').trim() === store.name &&
        (u.role === 'store_manager' || u.role === 'store_production_manager')
      );
      const uniqueUsernames = [...new Set(targets.map(u => String(u.username || '').trim()).filter(Boolean))];
      
      for (const username of uniqueUsernames) {
        const feishuUser = await lookupFeishuUserByUsername(username);
        if (feishuUser?.open_id) {
          const formUrl = 'https://ycnp8e71t8x8.feishu.cn/base/PtVObRtoPaMAP3stIIFc8DnJngd?table=tblxHI9ZAKONOTpp&view=vewjuqywQu';
          const typeLabel = config.checkType === 'opening' ? '开市' : '收档';
          
          const card = {
            config: { wide_screen_mode: true },
            header: { title: { tag: 'plain_text', content: `${config.brand}${typeLabel}检查提醒` }, template: 'blue' },
            elements: [
              {
                tag: 'div',
                text: {
                  tag: 'lark_md',
                  content: `**${config.brand} - ${store.name}**\n\n⏰ **时间**: ${config.time}\n**类型**: ${typeLabel}检查\n\n📋 请点击下方链接填写检查表：\n${formUrl}\n\n✅ 填写完成后系统会自动确认\n\n如有问题请联系督导员。`
                }
              }
            ]
          };
          
          const cardResult = await sendLarkCard(feishuUser.open_id, card);
          if (cardResult.ok) {
            console.log(`[ops] sent scheduled checklist to ${store.name} (${username})`);
          }
        }
      }
    } catch (e) {
      console.error(`[ops] failed to send checklist to ${storeKey}:`, e?.message);
    }
  }
}

async function sendSafetyCheck(config) {
  // 随机选择一个门店进行食安抽检
  const sharedState = await getSharedState();
  const stores = Object.entries(sharedState.stores || {});
  
  if (stores.length === 0) {
    console.log('[ops] no stores available for safety check');
    return;
  }
  
  const [storeKey, store] = stores[Math.floor(Math.random() * stores.length)];
  const feishuUser = await lookupFeishuUserByUsername(store.manager || '');
  
  if (feishuUser?.open_id) {
    const safetyTasks = [
      '请拍摄海鲜池水温计照片',
      '请检查冰箱温度记录',
      '请拍摄后厨卫生状况',
      '请检查食材分装情况',
      '请拍摄洗手台清洁状况'
    ];
    
    const randomTask = safetyTasks[Math.floor(Math.random() * safetyTasks.length)];
    
    const message = `🔔 **食安抽检**\n\n**门店**: ${store.name}\n**任务**: ${randomTask}\n**时间**: ${new Date().toLocaleString()}\n\n请在15分钟内完成并上传照片。`;
    
    await sendLarkMessage(feishuUser.open_id, prefixWithAgentName('ops_supervisor', message));
    console.log(`[ops] sent safety check to ${store.name}: ${randomTask}`);
  }
}

// 辅助函数：从AI回复中提取分数
function extractScore(text) {
  if (!text) return 0;
  const match = text.match(/(\d+(?:\.\d+)?)\s*\/\s*10|评分[：:]\s*(\d+(?:\d+)?)/i);
  return match ? parseFloat(match[1] || match[2]) : 0;
}

// 照片真实性验证
async function validatePhotoAuthenticity(imageUrl, expectedLocation, submitTime) {
  console.log('[ops] validating photo authenticity...');
  
  try {
    // 1. 调用视觉 AI 分析照片内容
    const visionResult = await callVisionLLM([
      { type: 'image', image_url: imageUrl },
      { type: 'text', text: `请分析这张照片：1.拍摄地点是否为${expectedLocation} 2.照片中的环境特征 3.是否有时间显示 4.照片真实性评估` }
    ]);
    
    // 2. 模拟 EXIF 和 GPS 验证（实际需要更复杂的实现）
    const now = Date.now();
    const timeDiff = Math.abs(now - submitTime);
    const isTimeValid = timeDiff < 5 * 60 * 1000; // 5分钟内
    
    // 3. 照片 Hash 简单验证（实际需要更复杂的实现）
    const photoHash = imageUrl.split('/').pop(); // 简化实现
    const isDuplicate = await checkPhotoDuplicate(photoHash);
    
    const validation = {
      isAuthentic: isTimeValid && !isDuplicate,
      timeValid: isTimeValid,
      notDuplicate: !isDuplicate,
      locationMatch: visionResult.content?.includes(expectedLocation) || false,
      confidence: 0.8 // 简化实现
    };
    
    console.log('[ops] photo validation result:', validation);
    return validation;
  } catch (e) {
    console.error('[ops] photo validation failed:', e?.message);
    return { isAuthentic: false, error: e?.message };
  }
}

// 检查照片重复
async function checkPhotoDuplicate(photoHash) {
  try {
    const result = await pool().query(
      'SELECT COUNT(*) as count FROM agent_messages WHERE content_type LIKE %image% AND agent_data::text ILIKE $1',
      [`%${photoHash}%`]
    );
    return (result.rows[0]?.count || 0) > 1;
  } catch (e) {
    console.error('[ops] check duplicate failed:', e?.message);
    return false;
  }
}

// 强化催办逻辑
async function handleTaskEscalation(taskId, assignee, taskType, overdueMinutes) {
  console.log(`[ops] handling escalation for task ${taskId}, overdue: ${overdueMinutes}min`);
  
  let escalationLevel = 'reminder';
  let message = '';
  
  if (overdueMinutes >= 60) {
    escalationLevel = 'performance_mark';
    message = `⚠️ 任务超时 ${overdueMinutes} 分钟，已标记绩效问题\n任务ID: ${taskId}\n请立即处理！`;
    
    // 标记绩效问题
    try {
      await pool().query(
        `INSERT INTO agent_messages (direction, channel, content_type, content, agent_data)
         VALUES ('system','feishu','performance_issue',$1,$2::jsonb)`,
        [`任务响应迟缓 - ${taskType}`, JSON.stringify({ taskId, assignee, overdueMinutes })]
      );
    } catch (e) {}
    
  } else if (overdueMinutes >= 15) {
    escalationLevel = 'strong_reminder';
    message = `🔔 任务已超时 ${overdueMinutes} 分钟\n任务ID: ${taskId}\n请尽快处理！`;
  } else {
    message = `💡 温馨提醒：任务待处理\n任务ID: ${taskId}`;
  }
  
  // 发送催办消息
  if (assignee?.id) {
    await sendLarkMessage(assignee.id, prefixWithAgentName('ops_supervisor', message));
  }
  
  return { escalationLevel, message };
}

// 逻辑纠偏检查
async function validateSubmissionLogic(submission) {
  console.log('[ops] validating submission logic...');
  
  const issues = [];
  
  // 1. 检查数据逻辑一致性
  if (submission.checkType === '开档检查' && submission.checkStatus === '不合格') {
    if (!submission.checkRemark || submission.checkRemark.length < 10) {
      issues.push('不合格项需要详细说明原因');
    }
  }
  
  // 2. 检查照片与描述的一致性
  if (submission.checkPhotos && submission.checkPhotos.length > 0) {
    if (submission.checkRemark.includes('干净') && submission.checkPhotos.length === 0) {
      issues.push('描述环境干净但未提供照片验证');
    }
  }
  
  // 3. 检查时间逻辑
  const submitHour = new Date(submission.submitTime).getHours();
  if (submission.checkType === '开档检查' && (submitHour < 8 || submitHour > 12)) {
    issues.push('开档检查时间异常，应在上午8-12点进行');
  }
  
  return {
    isValid: issues.length === 0,
    issues,
    suggestion: issues.length > 0 ? `检测到以下问题：${issues.join('；')}。请核实后重新提交。` : ''
  }
}

// ─────────────────────────────────────────────
// Send plain text message to a user by open_id
export async function sendLarkMessage(openId, text) {
  // 消息去重检查
  if (!deduplicateMessage(text, openId)) {
    return { ok: true, deduplicated: true };
  }
  
  const token = await getLarkTenantToken();
  if (!token) { console.error('[feishu] cannot send: no token'); return { ok: false, error: 'no_token' }; }
  try {
    const resp = await axios.post(
      'https://open.feishu.cn/open-apis/im/v1/messages',
      { receive_id: openId, msg_type: 'text', content: JSON.stringify({ text }) },
      { headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }, params: { receive_id_type: 'open_id' }, timeout: 10000 }
    );
    console.log('[feishu] message sent to', openId, '→', resp.data?.code === 0 ? 'ok' : resp.data?.msg);
    if (resp.data?.code === 99992361 || String(resp.data?.msg || '').includes('open_id cross app')) {
      try {
        await pool().query(
          `UPDATE feishu_users
           SET registered = FALSE, updated_at = NOW()
           WHERE open_id = $1`,
          [String(openId || '').trim()]
        );
      } catch (e) {}
    }
    return { ok: resp.data?.code === 0, data: resp.data };
  } catch (e) {
    const code = Number(e?.response?.data?.code || 0);
    const msg = String(e?.response?.data?.msg || '').toLowerCase();
    if (code === 99992361 || msg.includes('open_id cross app')) {
      try {
        await pool().query(
          `UPDATE feishu_users
           SET registered = FALSE, updated_at = NOW()
           WHERE open_id = $1`,
          [String(openId || '').trim()]
        );
      } catch (err) {}
    }
    console.error('[feishu] send message failed:', e?.response?.data || e?.message);
    return { ok: false, error: String(e?.message || e) };
  }
}

// Send interactive card (rich message) to a user
export async function sendLarkCard(openId, card) {
  const token = await getLarkTenantToken();
  if (!token) return { ok: false, error: 'no_token' };
  try {
    const resp = await axios.post(
      'https://open.feishu.cn/open-apis/im/v1/messages',
      { receive_id: openId, msg_type: 'interactive', content: JSON.stringify(card) },
      { headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }, params: { receive_id_type: 'open_id' }, timeout: 10000 }
    );
    return { ok: resp.data?.code === 0, data: resp.data };
  } catch (e) {
    console.error('[feishu] send card failed:', e?.response?.data || e?.message);
    return { ok: false, error: String(e?.message || e) };
  }
}

// Download image from Feishu message
export async function getLarkImageUrl(messageId, imageKey) {
  const token = await getLarkTenantToken();
  if (!token) return null;
  try {
    const resp = await axios.get(
      `https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/resources/${imageKey}`,
      { headers: { 'Authorization': `Bearer ${token}` }, params: { type: 'image' }, responseType: 'arraybuffer', timeout: 30000 }
    );
    const b64 = Buffer.from(resp.data).toString('base64');
    return `data:image/jpeg;base64,${b64}`;
  } catch (e) {
    console.error('[feishu] get image failed:', e?.message);
    return null;
  }
}

// Reply to a specific message
async function replyLarkMessage(messageId, text) {
  const token = await getLarkTenantToken();
  if (!token) return { ok: false };
  try {
    const resp = await axios.post(
      `https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/reply`,
      { msg_type: 'text', content: JSON.stringify({ text }) },
      { headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 10000 }
    );
    return { ok: resp.data?.code === 0 };
  } catch (e) {
    console.error('[feishu] reply failed:', e?.message);
    return { ok: false };
  }
}

// ─────────────────────────────────────────────
// 5. Feishu ↔ HRMS User Mapping
// ─────────────────────────────────────────────

async function lookupFeishuUser(openId) {
  try {
    const r = await pool().query('SELECT * FROM feishu_users WHERE open_id = $1 LIMIT 1', [openId]);
    return r.rows?.[0] || null;
  } catch (e) { return null; }
}

export async function lookupFeishuUserByUsername(username) {
  try {
    const r = await pool().query(
      `SELECT *
       FROM feishu_users
       WHERE username = $1 AND registered = TRUE
       ORDER BY updated_at DESC, created_at DESC
       LIMIT 1`,
      [username]
    );
    return r.rows?.[0] || null;
  } catch (e) { return null; }
}

// 推送督办消息给责任人，并抄送总部营运和管理员
// H6-FIX: 合并为单次 getSharedState 调用，避免批量场景下的DB过载
async function pushIssueToAssignee(issue, message) {
  const recipients = [];
  
  // 1. 发送给直接责任人（店长/出品经理）
  if (issue.assignee_username) {
    const assignee = await lookupFeishuUserByUsername(issue.assignee_username);
    if (assignee?.open_id) {
      recipients.push({ openId: assignee.open_id, role: 'assignee', username: issue.assignee_username });
    }
  }
  
  // 2+3. 一次性查找总部营运和管理员
  try {
    const state = await getSharedState();
    const allUsers = [
      ...(Array.isArray(state?.employees) ? state.employees : []),
      ...(Array.isArray(state?.users) ? state.users : [])
    ];
    
    // 总部营运（hq_manager）
    const hqManagers = allUsers.filter(u => u.role === 'hq_manager');
    for (const mgr of hqManagers) {
      const fu = await lookupFeishuUserByUsername(mgr.username);
      if (fu?.open_id) {
        recipients.push({ openId: fu.open_id, role: 'hq_manager', username: mgr.username });
      }
    }
    
    // 管理员（admin）
    const admins = allUsers.filter(u => u.role === 'admin');
    for (const adm of admins) {
      const fu = await lookupFeishuUserByUsername(adm.username);
      if (fu?.open_id) {
        recipients.push({ openId: fu.open_id, role: 'admin', username: adm.username });
      }
    }
  } catch (e) {
    console.error('[pushIssue] 查找抄送人失败:', e?.message);
  }
  
  // 发送消息给所有接收人
  const results = [];
  for (const recipient of recipients) {
    try {
      // 根据角色调整消息前缀
      let roleLabel = '';
      if (recipient.role === 'assignee') {
        roleLabel = `【OP督办】`;
      } else if (recipient.role === 'hq_manager') {
        roleLabel = `【OP督办-抄送总部营运】`;
      } else if (recipient.role === 'admin') {
        roleLabel = `【OP督办-抄送管理员】`;
      }
      
      const fullMessage = `${roleLabel}\n${message}`;
      const result = await sendLarkMessage(recipient.openId, fullMessage);
      results.push({ ...recipient, success: result.ok });
    } catch (e) {
      console.error(`[pushIssue] 发送给${recipient.username}失败:`, e?.message);
      results.push({ ...recipient, success: false, error: e?.message });
    }
  }
  
  return { issueId: issue.id, recipients: results.length, results };
}

async function registerFeishuUser(openId, username) {
  const state = await getSharedState();
  const user = findUserInState(state, username);
  if (!user) return { ok: false, error: 'user_not_found' };

  const uname = String(user.username || username).trim();
  const name = String(user.name || '').trim();
  const store = String(user.store || '').trim();
  const brandCtx = resolveBrandContextByStore(state, store);
  const role = String(user.role || '').trim();

  try {
    await pool().query(
      `UPDATE feishu_users
       SET registered = FALSE, updated_at = NOW()
       WHERE username = $1 AND open_id <> $2`,
      [uname, openId]
    );

    await pool().query(
      `INSERT INTO feishu_users (open_id, username, name, store, role, registered)
       VALUES ($1, $2, $3, $4, $5, TRUE)
       ON CONFLICT (open_id) DO UPDATE SET username = $2, name = $3, store = $4, role = $5, registered = TRUE, updated_at = NOW()`,
      [openId, uname, name, store, role]
    );
    return { ok: true, user: { username: uname, name, store, role, brandId: brandCtx.brandId, brandName: brandCtx.brandName } };
  } catch (e) {
    console.error('[feishu] register user failed:', e?.message);
    return { ok: false, error: String(e?.message) };
  }
}

// Build an alert card for Feishu
function buildAlertCard(title, severity, detail, actions) {
  const color = severity === 'high' ? 'red' : 'orange';
  const elements = [
    { tag: 'div', text: { tag: 'lark_md', content: detail } }
  ];
  if (actions && actions.length) {
    elements.push({
      tag: 'action',
      actions: actions.map(a => ({
        tag: 'button',
        text: { tag: 'plain_text', content: a.text },
        type: a.type || 'default',
        value: a.value || {}
      }))
    });
  }
  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: title }, template: color },
    elements
  };
}

// ─────────────────────────────────────────────
// 6. Agent 1: Data Auditor (数据审计员)
// ─────────────────────────────────────────────

// 注意：扣分规则已移交给 Chief Evaluator (OKR) 管理
// Data Auditor 只负责异常检测，不负责评分

// 注意：图片审核扣分规则已移交给 Chief Evaluator (OKR) 管理
// Data Auditor 只负责异常检测，不负责评分

// 注意：品牌评分模型已移交给 Chief Evaluator (OKR) 管理
// Data Auditor 只负责异常检测，不负责评分

// 注意：扣分计算函数已移交给 Chief Evaluator (OKR) 管理
// Data Auditor 只负责异常检测，不负责评分

// 注意：扣分计算函数已移交给 Chief Evaluator (OKR) 管理
// Data Auditor 只负责异常检测，不负责评分

// 注意：图片审核扣分函数已移交给 Chief Evaluator (OKR) 管理
// Data Auditor 只负责异常检测，不负责评分

// 注意：品牌维度得分计算函数已移交给 Chief Evaluator (OKR) 管理
// Data Auditor 只负责异常检测，不负责评分

// 注意：月度绩效计算函数已移交给 Chief Evaluator (OKR) 管理
// Data Auditor 只负责异常检测，不负责评分

// ─────────────────────────────────────────────
// Data Auditor 核心功能：只负责异常检测，不负责评分
// ─────────────────────────────────────────────

export async function runDataAuditor() {
  const state = await getSharedState();
  const reports = Array.isArray(state?.dailyReports) ? state.dailyReports : [];
  const stores = getStoresFromState(state);
  const issues = [];
  
  // 重新启用数据源质量检查（带错误处理）
  await checkDataSourceQuality();

  for (const storeInfo of stores) {
    const storeName = storeInfo.name;
    const brandCtx = resolveBrandContextByStore(state, storeName);
    const brand = brandCtx.brandName || storeInfo.brand || inferBrandFromStoreName(storeName) || '洪潮';

    const now = new Date();
    const nowDate = toDateOnly(now.toISOString());
    const weekAgo = new Date(now.getTime() - 7 * 86400000);
    const weekAgoDate = toDateOnly(weekAgo.toISOString());

    const storeReports = reports.filter(r => {
      if (String(r?.store || '').trim() !== storeName) return false;
      return inDateRangeInclusive(r?.date, weekAgoDate, nowDate);
    });
    if (!storeReports.length) {
      // 报告数据源不足问题
      await AgentCommunicationHelper.reportDataSourceIssue(
        'daily_reports',
        `门店 ${storeName} 缺少营业数据`,
        '无法进行营收异常检测',
        '建议检查数据同步机制'
      );
      continue;
    }

    const tableVisitMetrics = await loadTableVisitMetricsByStore(storeName, weekAgoDate, nowDate);
    const reportsSorted = storeReports
      .slice()
      .sort((a, b) => String(a?.date || '').localeCompare(String(b?.date || '')));

    // 1) 实收营收异常（按月累计达成率 vs 理论达成率）
    // 规则：每周一早上10点检查，比较当月1号到上周日的累计数据
    // 达成率差值 >10% 为 medium, >20% 为 high
    const ym = nowDate.slice(0, 7);
    const target = getMonthlyTarget(state, ym, storeName);
    const targetActual = toNum(target?.targets?.actual, 0);
    if (targetActual > 0) {
      // 获取当月1号到当前日期（上周日）的所有数据
      const monthStart = `${ym}-01`;
      const monthReports = storeReports.filter(r => {
        const d = toDateOnly(r?.date);
        return d && d >= monthStart && d <= nowDate;
      });
      
      // 累计实收营业额
      const cumulativeActual = monthReports.reduce((s, r) => s + toNum(r?.data?.actual, 0), 0);
      // 已过天数（从上个月1号到上周日）
      const daysPassed = monthReports.length;
      const monthDays = Math.max(1, daysInMonth(nowDate));
      
      // 实际达成率 vs 理论达成率
      const actualAchieveRate = cumulativeActual / targetActual;
      const theoryAchieveRate = daysPassed / monthDays;
      const gap = theoryAchieveRate - actualAchieveRate;
      
      if (gap > 0.10) {
        const severity = gap > 0.20 ? 'high' : 'medium';
        issues.push({
          agent: 'data_auditor', brand, store: storeName, category: '实收营收异常',
          severity,
          title: `${storeName} 累计实收营收达成偏低（${daysPassed}天较理论差 ${(gap * 100).toFixed(1)}%）`,
          detail: `${ym}月1日至${nowDate}累计：实收达成率 ${(actualAchieveRate * 100).toFixed(1)}%，理论达成率 ${(theoryAchieveRate * 100).toFixed(1)}%（${daysPassed}/${monthDays}天），差值 ${(gap * 100).toFixed(1)}%。`,
          data: {
            date: nowDate,
            periodStart: monthStart,
            periodEnd: nowDate,
            daysPassed,
            monthDays,
            cumulativeActual: Number(cumulativeActual.toFixed(2)),
            targetActual: Number(targetActual.toFixed(2)),
            actualAchieveRate: Number((actualAchieveRate * 100).toFixed(2)),
            theoryAchieveRate: Number((theoryAchieveRate * 100).toFixed(2)),
            achieveGap: Number((gap * 100).toFixed(2))
          }
        });
      }
    }

    // 2) 人效值异常（按品牌）
    // 洪潮: <1100为medium, <1000为high; 马己仙: <1400为medium, <1300为high
    const efficiencyThresholds = brand.includes('马己仙')
      ? { medium: 1400, high: 1300 }
      : { medium: 1100, high: 1000 };

    for (const report of reportsSorted) {
      const data = report?.data || {};
      const reportDate = toDateOnly(report?.date);
      if (!reportDate) continue;
      const gross = toNum(data?.gross, 0);
      const laborTotal = toNum(data?.laborTotal, 0);
      const efficiency = toNum(data?.efficiency, laborTotal > 0 ? (gross / laborTotal) : 0);
      if (!(efficiency > 0)) continue;

      let severity = '';
      if (efficiency < efficiencyThresholds.high) severity = 'high';
      else if (efficiency < efficiencyThresholds.medium) severity = 'medium';
      if (!severity) continue;

      issues.push({
        agent: 'data_auditor', brand, store: storeName, category: '人效值异常',
        severity,
        title: `${storeName} ${reportDate} 人效偏低（${efficiency.toFixed(0)}）`,
        detail: `品牌阈值：medium < ${efficiencyThresholds.medium}，high < ${efficiencyThresholds.high}。当前人效 ${efficiency.toFixed(0)}。`,
        data: { date: reportDate, efficiency: Number(efficiency.toFixed(2)) }
      });
    }

    // 3) 充值异常（单日无充值 / 连续2天无充值）
    let rechargeStreak = 0;
    let prevDate = '';
    for (const report of reportsSorted) {
      const reportDate = toDateOnly(report?.date);
      if (!reportDate) continue;
      const rechargeAmount = toNum(report?.data?.recharge?.amount, 0);
      const noRecharge = rechargeAmount <= 0;

      if (noRecharge) {
        issues.push({
          agent: 'data_auditor', brand, store: storeName, category: '充值异常',
          severity: 'medium',
          title: `${storeName} ${reportDate} 当日无充值`,
          detail: `当日充值金额为 0。`,
          data: { date: reportDate, rechargeAmount: 0 }
        });
      }

      if (noRecharge && isConsecutiveDate(prevDate, reportDate)) rechargeStreak += 1;
      else rechargeStreak = noRecharge ? 1 : 0;

      if (rechargeStreak >= 2) {
        issues.push({
          agent: 'data_auditor', brand, store: storeName, category: '充值异常',
          severity: 'high',
          title: `${storeName} 连续2天无充值`,
          detail: `截至 ${reportDate} 已连续 ${rechargeStreak} 天无充值。`,
          data: { date: reportDate, noRechargeDays: rechargeStreak }
        });
      }
      prevDate = reportDate;
    }

    // 4) 桌访产品异常（同一产品7天内投诉检测）
    // 规则: 1周内同一产品投诉>2次为medium, >4次为high
    const productComplaints = tableVisitMetrics.dissatisfiedProducts;
    for (const [key, count] of productComplaints) {
      if (count >= 2) {
        const [, product] = key.split('||');
        issues.push({
          agent: 'data_auditor', brand, store: storeName, category: '桌访产品异常',
          severity: count >= 4 ? 'high' : 'medium',
          title: `${storeName} 近7天「${product}」不满意 ${count} 次`,
          detail: `同一产品7天内不满意次数 ${count} 次（medium:≥2次, high:≥4次）。`,
          data: { date: nowDate, dissatisfiedProducts: product, dissatisfiedCount: count }
        });
      }
    }

    // 5) 桌访占比异常（每周桌访占比）
    // 规则: 桌访率<50%为medium, <40%为high; 数据来源: 堂食订单数
    const weekVisits = Array.from(tableVisitMetrics.countByDate.values()).reduce((s, n) => s + toNum(n, 0), 0);
    // 从营业日报获取堂食订单数作为总桌数
    const weekDineOrders = storeReports.reduce((s, r) => s + toNum(r?.data?.dine?.orders, 0), 0);
    const tableVisitRatio = weekDineOrders > 0 ? (weekVisits / weekDineOrders) : 0;
    if (weekDineOrders > 0 && tableVisitRatio < 0.5) {
      issues.push({
        agent: 'data_auditor', brand, store: storeName, category: '桌访占比异常',
        severity: tableVisitRatio < 0.4 ? 'high' : 'medium',
        title: `${storeName} 近7天桌访占比偏低（${(tableVisitRatio * 100).toFixed(1)}%）`,
        detail: `桌访数量 ${weekVisits}，堂食订单数量 ${weekDineOrders}，桌访占比 ${(tableVisitRatio * 100).toFixed(1)}%（medium:<50%, high:<40%）。`,
        data: {
          date: nowDate,
          tableVisitCount: weekVisits,
          dineOrders: weekDineOrders,
          tableVisitOrderRatio: Number((tableVisitRatio * 100).toFixed(2))
        }
      });
    }

    // 6) 总实收毛利率异常（每周按品牌阈值）
    // 马己仙: <64%为medium, <63%为high; 洪潮: <69%为medium, <68%为high
    const marginMetrics = estimateMarginMetricsForRange({
      state,
      store: storeName,
      startDate: weekAgoDate,
      endDate: nowDate
    });
    const totalMarginRate = toNum(marginMetrics?.total?.marginRate, 0);
    const marginThresholds = brand.includes('马己仙')
      ? { medium: 0.64, high: 0.63 }
      : { medium: 0.69, high: 0.68 };
    if (marginMetrics.total.actualRevenue > 0 && totalMarginRate < marginThresholds.medium) {
      issues.push({
        agent: 'data_auditor', brand, store: storeName, category: '总实收毛利率异常',
        severity: totalMarginRate < marginThresholds.high ? 'high' : 'medium',
        title: `${storeName} 近7天总实收毛利率偏低（${(totalMarginRate * 100).toFixed(1)}%）`,
        detail: `品牌阈值：medium < ${(marginThresholds.medium * 100).toFixed(0)}%，high < ${(marginThresholds.high * 100).toFixed(0)}%。当前 ${(totalMarginRate * 100).toFixed(1)}%。`,
        data: {
          date: nowDate,
          totalActualRevenue: Number(toNum(marginMetrics?.total?.actualRevenue, 0).toFixed(2)),
          totalEstimatedCost: Number(toNum(marginMetrics?.total?.estimatedCost, 0).toFixed(2)),
          totalMarginRate: Number((totalMarginRate * 100).toFixed(2))
        }
      });
    }

    // 7) 产品差评异常 / 服务差评异常（从差评报告DB检测，每周统计）
    // 规则: 1周内1条差评为medium, 2条为high; 洪潮马己仙一样
    try {
      const day7Ago = new Date(now.getTime() - 7 * 86400000);
      const day7AgoDate = toDateOnly(day7Ago.toISOString());

      // 产品差评统计（1周内）
      const productReviews = await pool().query(
        `SELECT product_name, COUNT(*) as cnt
         FROM bad_reviews
         WHERE store = $1 AND review_type = 'product'
           AND date >= $2::date AND date <= $3::date
           AND product_name IS NOT NULL AND product_name != ''
         GROUP BY product_name`,
        [storeName, day7AgoDate, nowDate]
      );

      for (const row of (productReviews.rows || [])) {
        const product = String(row.product_name || '').trim();
        const count7d = Number(row.cnt || 0);
        if (count7d >= 1) {
          issues.push({
            agent: 'data_auditor', brand, store: storeName, category: '产品差评异常',
            severity: count7d >= 2 ? 'high' : 'medium',
            title: `${storeName} 「${product}」近7天收到 ${count7d} 次产品差评`,
            detail: `产品「${product}」在7天内收到 ${count7d} 次差评（medium:≥1条, high:≥2条）。`,
            data: {
              date: nowDate,
              productName: product,
              reviewCount: count7d,
              periodDays: 7,
              reviewType: 'product'
            }
          });
        }
      }

      // 服务差评统计（1周内）
      const serviceReviews = await pool().query(
        `SELECT service_item, COUNT(*) as cnt
         FROM bad_reviews
         WHERE store = $1 AND review_type = 'service'
           AND date >= $2::date AND date <= $3::date
           AND service_item IS NOT NULL AND service_item != ''
         GROUP BY service_item`,
        [storeName, day7AgoDate, nowDate]
      );

      for (const row of (serviceReviews.rows || [])) {
        const service = String(row.service_item || '').trim();
        const count7d = Number(row.cnt || 0);
        if (count7d >= 1) {
          issues.push({
            agent: 'data_auditor', brand, store: storeName, category: '服务差评异常',
            severity: count7d >= 2 ? 'high' : 'medium',
            title: `${storeName} 「${service}」服务近7天收到 ${count7d} 次差评`,
            detail: `服务项「${service}」在7天内收到 ${count7d} 次差评（medium:≥1条, high:≥2条）。`,
            data: {
              date: nowDate,
              serviceItem: service,
              reviewCount: count7d,
              periodDays: 7,
              reviewType: 'service'
            }
          });
        }
      }
    } catch (e) {
      // bad_reviews表可能不存在，忽略
    }
  }

  // Persist and return
  let created = 0;
  const newIssueIds = [];
  for (const issue of issues) {
    try {
      // Dedup by store + category + report date (not title, which can vary between runs)
      const issueDate = String(issue.data?.date || '').trim();
      const existing = await pool().query(
        `SELECT id FROM agent_issues
         WHERE store = $1 AND category = $2
           AND (data->>'date' = $3 OR ($3 = '' AND created_at > NOW() - INTERVAL '24 hours'))
           AND created_at > NOW() - INTERVAL '7 days'
         LIMIT 1`,
        [issue.store, issue.category, issueDate]
      );
      if (existing.rows?.length) continue;

      const assignee = await findStoreManager(state, issue.store);
      const r = await pool().query(
        `INSERT INTO agent_issues (agent, brand, store, category, severity, title, detail, data, assignee_username)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9) RETURNING id`,
        [issue.agent, issue.brand, issue.store, issue.category, issue.severity,
         issue.title, issue.detail, JSON.stringify(issue.data), assignee]
      );
      created++;
      if (r.rows?.[0]?.id) newIssueIds.push(r.rows[0].id);
    } catch (e) {
      console.error('[data_auditor] insert issue failed:', e?.message);
    }
  }

  return { scanned: reports.length, issuesFound: issues.length, issuesCreated: created, newIssueIds };
}

// ─────────────────────────────────────────────
// 7. Agent 2: Operational Supervisor (营运督导员)
// ─────────────────────────────────────────────

// 营运督导员工作职责配置
const OPS_AGENT_CONFIG = {
  // 任务调度与主动触发
  scheduledTasks: {
    // 开/收市巡检
    dailyInspections: [
      { brand: '洪潮', type: 'opening', time: '10:30', checklist: ['地面清洁无积水', '所有设备正常开启', '食材新鲜度检查', '餐具消毒完成', '灯光亮度适中', '背景音乐开启', '空调温度设置合适', '员工仪容仪表检查'] },
      { brand: '马己仙', type: 'opening', time: '10:00', checklist: ['地面清洁', '设备开启', '食材准备', '餐具消毒', '迎宾准备'] },
      { brand: '洪潮', type: 'closing', time: '22:00', checklist: ['食材封存', '设备关闭', '垃圾清理', '安全检查', '门窗锁好'] },
      { brand: '马己仙', type: 'closing', time: '22:30', checklist: ['食材封存', '设备关闭', '垃圾清理', '安全检查', '门窗锁好', '电源关闭'] }
    ],
    // 食安抽检
    randomInspections: [
      { type: 'seafood_pool_temperature', description: '拍摄海鲜池水温计照片', timeWindow: 15 },
      { type: 'fridge_label_check', description: '检查冰箱标签是否过期', timeWindow: 10 },
      { type: 'hand_washing_duration', description: '录制洗手20秒视频', timeWindow: 5 }
    ],
    // 数据联动触发阈值（配合BI异常检测规则）
    dataTriggers: {
      // 产品投诉阈值：1周内同一产品投诉>2次触发medium，>4次触发high
      productComplaintThreshold: 2, 
      // 毛利偏差阈值：马己仙<64%/洪潮<69%为medium
      marginDeviationThreshold: 0.01, // 使用较小的容差确保能触发
      // 桌访率阈值：桌访率<50%触发medium，<40%触发high
      tableVisitRatioThreshold: 0.50  
    }
  },

  // 多模态视觉审核标准
  visualInspection: {
    // 环境检查标准
    environment: {
      floorWater: 'detect_water_or_oil_on_floor',
      trashCovered: 'trash_bin_lid_closed',
      lightingAdequate: 'lighting_sufficient_for_clear_photos'
    },
    // 产品检查标准  
    product: {
      platingAesthetics: '洪潮切配摆盘美学标准',
      portionSize: '分量是否达标',
      garnishPlacement: '装饰配菜摆放规范'
    },
    // 物料检查标准
    materials: {
      fridgeLabelExpiry: '冰箱标签是否过期',
      rawCookedSeparation: '生熟分装检查',
      storageTemperature: '储存温度合规'
    },
    // 视觉准确度要求
    accuracyThresholds: {
      labelClarity: 0.8,      // 标识清晰度 > 80%
      foodCoverage: 0.9,     // 食材遮盖率达标
      photoQuality: 0.85     // 照片质量要求
    }
  },

  // 执行闭环追踪
  loopManagement: {
    // 催办逻辑
    followUpRules: {
      firstReminder: 15,  // 15分钟内未读信
      secondReminder: 60, // 60分钟内未首次反馈
      escalationDelay: 120, // 2小时后升级
      maxReminders: 3      // 最多提醒3次
    },
    // 逻辑纠偏检查
    logicValidation: {
      photoLocationRadius: 500, // 门店500米内
      exifTimeTolerance: 5,     // Exif时间误差<5分钟
      hashDuplicateCheck: true, // Hash重复检查
      dataConsistency: true     // 数据一致性检查
    }
  },

  // 判定逻辑标准
  judgmentStandards: {
    timeliness: {
      readDeadline: 15,    // 15分钟内读信
      responseDeadline: 60, // 60分钟内首次反馈
      latePenalty: 'mark_slow_response' // 超时标记响应迟缓
    },
    authenticity: {
      locationRadius: 500,
      exifTolerance: 300,  // 5分钟=300秒
      hashCheck: true,
      fraudAction: 'block_and_report' // 作假直接封禁并上报
    },
    visualAccuracy: {
      minClarity: 0.8,
      minCoverage: 0.9,
      poorQualityResponse: '环境光线不足，请打开补光灯重拍'
    },
    logicConsistency: {
      dataTolerance: 0.1,   // 10%数据偏差容忍度
      inconsistencyResponse: '检测到数据偏差较大，请核实后再提交'
    }
  },

  // 现场知识支援
  knowledgeSupport: {
    // SOP知识库调用规则
    sopQueryRules: {
      productQuality: '产品质量问题处理流程',
      ingredientHandling: '食材处理标准',
      equipmentOperation: '设备操作规范',
      emergencyProcedures: '紧急情况处理'
    },
    // 常见问题标准回复
    standardResponses: {
      smallOysters: '根据洪潮验收SOP第3条，超过20%不达标需拍图留存并做退货登记。请拍摄对比照片。',
      fridgeTemperature: '冰箱温度应保持在4°C以下，请检查温控设置并记录当前温度。',
      handWashing: '洗手必须满20秒，请使用洗手液并冲洗至手腕部位。'
    }
  }
};

export async function auditImage(imageUrl, auditType, context = {}) {
  const store = context.store || '';
  const brand = context.brand || '';
  const username = context.username || '';
  const config = OPS_AGENT_CONFIG;

  // Anti-cheat: image hash
  let imageHash = '';
  let exifData = {};
  try {
    let buf;
    if (imageUrl.startsWith('/') || imageUrl.startsWith('.')) {
      buf = fs.readFileSync(imageUrl);
    } else if (imageUrl.startsWith('data:')) {
      const b64 = imageUrl.split(',')[1] || '';
      buf = Buffer.from(b64, 'base64');
    }
    if (buf) {
      imageHash = crypto.createHash('sha256').update(buf).digest('hex');
      // TODO: 提取Exif数据用于时间验证
      exifData = { timestamp: new Date().toISOString() }; // 临时使用当前时间
    }
  } catch (e) {}

  let duplicateOf = null;
  if (imageHash) {
    try {
      const dup = await pool().query(
        `SELECT id FROM agent_visual_audits WHERE image_hash = $1 LIMIT 1`, [imageHash]
      );
      if (dup.rows?.length) duplicateOf = dup.rows[0].id;
    } catch (e) {}
  }

  // 根据审核类型选择Prompt
  const typePrompts = {
    hygiene: `你是餐饮卫生检查专家。审核这张图片：1.是否为餐厅卫生相关照片 2.卫生状况如何 3.给出pass/fail/unclear。JSON回复：{"result":"pass/fail/unclear","confidence":0.0-1.0,"findings":"具体发现","clarity":0.0-1.0}`,
    plating: `你是餐饮出品专家。审核这张菜品照片：1.摆盘是否规范 2.分量是否达标 3.美学标准。JSON回复：{"result":"pass/fail/unclear","confidence":0.0-1.0,"findings":"具体发现","clarity":0.0-1.0}`,
    general: `你是餐饮营运督导。审核这张照片：1.照片类型 2.是否与餐饮营运相关 3.质量评估。JSON回复：{"result":"pass/fail/unclear","confidence":0.0-1.0,"findings":"具体发现","type":"照片类型","clarity":0.0-1.0}`,
    seafood_pool_temperature: `你是海鲜池管理专家。审核这张水温计照片：1.温度是否清晰可见 2.温度是否在标准范围内(18-22°C) 3.水温计是否正常工作。JSON回复：{"result":"pass/fail/unclear","confidence":0.0-1.0,"findings":"具体发现","temperature":"数值"}`
  };

  const prompt = typePrompts[auditType] || typePrompts.general;
  const llmResult = await callVisionLLM(imageUrl, prompt);

  let result = 'unclear', confidence = 0, findings = '', agentRaw = {}, clarity = 0;
  if (llmResult.ok && llmResult.content) {
    try {
      const jsonMatch = llmResult.content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        result = String(parsed.result || 'unclear').trim().toLowerCase();
        confidence = Math.max(0, Math.min(1, Number(parsed.confidence || 0)));
        findings = String(parsed.findings || '').trim();
        clarity = Math.max(0, Math.min(1, Number(parsed.clarity || 0)));
        agentRaw = parsed;
      }
    } catch (e) { findings = llmResult.content; }
  } else {
    findings = `视觉审核API调用失败: ${llmResult.error || '未知错误'}`;
  }

  // 应用营运督导员的判定逻辑标准
  if (duplicateOf) {
    result = 'fail';
    findings = `⚠️ 重复图片（与历史记录重复），疑似作弊。${findings ? ' 原始审核: ' + findings : ''}`;
    confidence = 0.95;
  } else if (clarity < config.visualInspection.accuracyThresholds.labelClarity) {
    result = 'fail';
    findings = config.judgmentStandards.visualAccuracy.poorQualityResponse;
    confidence = 0.9;
  }

  // 时间验证（基于Exif数据）
  const now = new Date();
  const exifTime = new Date(exifData.timestamp || now);
  const timeDiff = Math.abs(now - exifTime) / 1000; // 秒
  if (timeDiff > config.judgmentStandards.authenticity.exifTolerance) {
    result = 'fail';
    findings = `照片拍摄时间异常（误差${Math.round(timeDiff/60)}分钟），请重新拍摄。`;
    confidence = 0.95;
  }

  let auditId = null;
  try {
    const r = await pool().query(
      `INSERT INTO agent_visual_audits (store, brand, username, image_url, audit_type, result, confidence, findings, image_hash, duplicate_of, agent_raw)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb) RETURNING id`,
      [store, brand, username, imageUrl, auditType || 'general', result, confidence,
       findings, imageHash || null, duplicateOf || null, JSON.stringify(agentRaw)]
    );
    auditId = r.rows?.[0]?.id || null;
  } catch (e) { console.error('[ops_supervisor] insert audit failed:', e?.message); }

  // 如果审核失败，创建异常记录
  if (result === 'fail') {
    try {
      await pool().query(
        `INSERT INTO agent_issues (agent, brand, store, category, severity, title, detail, data, assignee_username)
         VALUES ('ops_supervisor',$1,$2,'图片审核不合格','medium',$3,$4,$5::jsonb,$6)`,
        [brand, store, `${store} 图片审核不合格（${auditType || '通用'}）`, findings,
         JSON.stringify({ auditId, auditType, result, confidence, duplicateOf, clarity }), username]
      );
    } catch (e) {}
  }

  return { auditId, result, confidence, findings, duplicate: !!duplicateOf, imageHash, clarity };
}

// ─────────────────────────────────────────────
// 营运督导员知识支援功能
// ─────────────────────────────────────────────

// 现场知识支援 - 根据问题类型调用SOP知识库
export async function getOpsKnowledgeSupport(query, context = {}) {
  const store = context.store || '';
  const brand = context.brand || '';
  const config = OPS_AGENT_CONFIG.knowledgeSupport;
  
  // 检查是否为常见问题，返回标准回复
  const standardAnswers = {
    '生蚝个头偏小': config.standardResponses.smallOysters,
    '冰箱温度': config.standardResponses.fridgeTemperature,
    '洗手': config.standardResponses.handWashing
  };
  
  for (const [key, answer] of Object.entries(standardAnswers)) {
    if (query.includes(key)) {
      return { type: 'standard', response: answer, source: 'standard_responses' };
    }
  }
  
  // 查询SOP知识库
  let kbResults = [];
  try {
    // 查询知识库和 Bitable 数据
    const brandTag = brand ? `brand:${brand}` : '';
    const agentData = await queryAgentData(['sop', '流程', '标准', '规范'], query, 5, { brandTag });
    
    kbResults = agentData.knowledge || [];
    const bitableResults = agentData.bitable || [];
    
    // 合并结果
    if (bitableResults.length > 0) {
      kbResults = kbResults.concat(
        bitableResults.map(r => ({
          title: `Bitable数据 - ${r.content_type}`,
          content: `${r.content}\n数据时间: ${new Date(r.created_at).toLocaleString()}`,
          source: 'bitable'
        }))
      );
    }
  } catch (e) {
    console.error('[ops_supervisor] data query failed:', e?.message);
  }
  
  if (kbResults.length > 0) {
    const kbContent = kbResults.map(r => `【${r.title}】${r.content}`).join('\n\n');
    return { 
      type: 'knowledge_base', 
      response: `根据相关SOP标准：\n\n${kbContent}`,
      source: 'knowledge_base',
      results: kbResults 
    };
  }
  
  // 使用LLM生成专业建议
  try {
    const llmResult = await callLLM([
      { 
        role: 'system', 
        content: `你是资深餐饮营运督导，精通洪潮和马己仙品牌标准。当前门店：${store}（${brand}）。请提供专业、可操作的建议。` 
      },
      { role: 'user', content: query }
    ]);
    
    if (llmResult.ok && llmResult.content) {
      return { 
        type: 'llm_generated', 
        response: llmResult.content,
        source: 'ai_advisor'
      };
    }
  } catch (e) {
    console.error('[ops_supervisor] llm advice failed:', e?.message);
  }
  
  return { 
    type: 'fallback', 
    response: '这个问题需要进一步核实，请联系值班督导处理。',
    source: 'fallback'
  };
}

// 任务调度与主动触发
export async function scheduleOpsTasks() {
  const config = OPS_AGENT_CONFIG.scheduledTasks;
  const now = new Date();
  const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  
  const scheduledTasks = [];
  
  // 检查日常巡检任务
  for (const inspection of config.dailyInspections) {
    if (inspection.time === currentTime) {
      const stores = await getStoresForBrand(inspection.brand);
      for (const store of stores) {
        const task = {
          type: 'daily_inspection',
          brand: inspection.brand,
          store: store.name,
          inspectionType: inspection.type,
          checklist: inspection.checklist,
          scheduledTime: now.toISOString()
        };
        scheduledTasks.push(task);
      }
    }
  }
  
  return scheduledTasks;
}

// 数据联动触发检查
export async function checkDataTriggers() {
  const config = OPS_AGENT_CONFIG.scheduledTasks.dataTriggers;
  const triggers = [];
  
  // 检查产品投诉阈值
  try {
    const recentComplaints = await pool().query(`
      SELECT store, product_name, COUNT(*) as complaint_count
      FROM bad_reviews 
      WHERE review_type = 'product' 
        AND created_at > NOW() - INTERVAL '24 hours'
      GROUP BY store, product_name
      HAVING COUNT(*) >= $1
    `, [config.productComplaintThreshold]);
    
    for (const complaint of recentComplaints.rows) {
      triggers.push({
        type: 'product_complaints',
        store: complaint.store,
        product: complaint.product_name,
        count: complaint.complaint_count,
        action: 'check_production_process'
      });
    }
  } catch (e) {
    console.error('[ops_supervisor] data trigger check failed:', e?.message);
  }
  
  return triggers;
}

// 执行闭环追踪 - 催办逻辑
export async function followUpOverdueTasks() {
  const config = OPS_AGENT_CONFIG.loopManagement.followUpRules;
  const now = new Date();
  const followUps = [];
  
  // 检查超时未读的任务
  try {
    const unreadTasks = await pool().query(`
      SELECT t.*, u.open_id, u.name
      FROM master_tasks t
      JOIN users u ON t.assignee_username = u.username
      WHERE t.status = 'dispatched' 
        AND t.created_at < NOW() - make_interval(mins => $2)
        AND t.reminder_count < $1
    `, [config.maxReminders, Math.max(1, Math.floor(Number(config.firstReminder) || 15))]);
    
    for (const task of unreadTasks.rows) {
      // 发送飞书提醒
      const reminderMsg = prefixWithAgentName('ops_supervisor', 
        `【任务提醒】${task.assignee_username}，你有任务已超时${Math.round((now - new Date(task.created_at)) / 60000)}分钟未查看，请及时处理：${task.title}`);
      
      try {
        await sendLarkMessage(task.open_id, reminderMsg);
        
        // 更新提醒次数
        await pool().query(`
          UPDATE master_tasks 
          SET reminder_count = reminder_count + 1, 
              last_reminded_at = NOW()
          WHERE id = $1
        `, [task.id]);
        
        followUps.push({
          taskId: task.id,
          type: 'unread_reminder',
          assignee: task.assignee_username,
          reminderCount: task.reminder_count + 1
        });
      } catch (e) {
        console.error('[ops_supervisor] follow-up failed:', e?.message);
      }
    }
  } catch (e) {
    console.error('[ops_supervisor] overdue tasks check failed:', e?.message);
  }
  
  return followUps;
}

// 辅助函数：根据品牌获取门店列表
async function getStoresForBrand(brandName) {
  const state = await getSharedState();
  const stores = getStoresFromState(state);
  return stores.filter(s => s.brand === brandName);
}

export async function runChiefEvaluator(period) {
  const p = String(period || '').trim();
  if (!p) return { error: 'missing_period' };

  const state = await getSharedState();
  const stores = getStoresFromState(state);
  const results = [];

  for (const storeInfo of stores) {
    const storeName = storeInfo.name;
    const brandCtx = resolveBrandContextByStore(state, storeName);
    const brand = brandCtx.brandName || storeInfo.brand || inferBrandFromStoreName(storeName) || '洪潮';
    const config = getBrandRuntimeConfig(state, brandCtx);

    const all = [
      ...(Array.isArray(state?.employees) ? state.employees : []),
      ...(Array.isArray(state?.users) ? state.users : [])
    ];
    const managers = all.filter(u =>
      String(u?.store || '').trim() === storeName &&
      ['store_manager', 'store_production_manager'].includes(String(u?.role || '').trim())
    );

    // 使用新评分模型计算门店评级
    const storeRating = await calculateStoreRating(storeName, brand, p);

    for (const mgr of managers) {
      const username = String(mgr.username || '').trim();
      const mgrName = String(mgr.name || '').trim();
      const role = String(mgr.role || '').trim();
      if (!username) continue;

      // 使用新评分模型计算员工评分
      const employeeScore = await calculateEmployeeScore(storeName, username, role, p);
      
      if (!employeeScore) {
        console.log(`[HR] 员工评分计算失败: ${username}`);
        continue;
      }

      const totalScore = employeeScore.total_score;
      const breakdown = {
        execution_rating: employeeScore.execution_rating,
        attitude_rating: employeeScore.attitude_rating,
        ability_rating: employeeScore.ability_rating,
        store_rating: storeRating.rating || null
      };
      const deductions = []; // 新模型不使用扣分列表

      let summary = '';
      try {
        const llm = await callLLM([
          { role: 'system', content: '你是专业的餐饮绩效考核官，语言简洁务实。' },
          { role: 'user', content: `品牌${brand}（${config.label}），门店${storeName}，${mgr.name || username}（${role === 'store_manager' ? '店长' : '出品经理'}）。总分${totalScore}，门店评级${storeRating.rating || 'N/A'}，执行力${employeeScore.execution_rating}，态度${employeeScore.attitude_rating}，能力${employeeScore.ability_rating}。请给出2-3句评语。` }
        ]);
        summary = llm.content || '';
      } catch (e) {}

      try {
        await pool().query(
          `INSERT INTO agent_scores (brand, store, username, name, role, period, score_model, total_score, breakdown, deductions, summary)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11)
           ON CONFLICT (brand, store, username, period)
           DO UPDATE SET name=EXCLUDED.name, total_score=EXCLUDED.total_score, breakdown=EXCLUDED.breakdown, deductions=EXCLUDED.deductions, summary=EXCLUDED.summary, feishu_notified=FALSE, updated_at=NOW()`,
          [brand, storeName, username, mgrName, role, p, 'new_model', totalScore,
           JSON.stringify(breakdown), JSON.stringify(deductions), summary]
        );
      } catch (e) { console.error('[HR] upsert score failed:', e?.message); }

      results.push({ brand, store: storeName, username, name: mgrName, role, totalScore, breakdown, deductions: deductions.length, summary, store_rating: storeRating });
    }
  }

  return { period: p, evaluated: results.length, results, model: 'new_scoring_model' };
}

// ─────────────────────────────────────────────
// 9. Message Router
// ─────────────────────────────────────────────

const AUDIT_KEYWORDS = ['损耗', '盘点', '毛利', '牛肉', '成本', '差评', '折扣', '营收', '对账', '异常'];
const OPS_KEYWORDS = ['图片', '卫生', '检查', '拍照', '摆盘', '收货', '消毒', '开市', '闭市', '巡检'];
const EVAL_KEYWORDS = ['分数', '绩效', '考核', '奖金', '得分', '扣分', '排名', '评价', '这周'];
const HR_KEYWORDS = ['离职', '辞职', '入职', '转正', '晋升', '调岗', '加薪', '薪资', '工资', '请假', '休假', '社保', '人事', '档案', '考勤'];
const APPEAL_KEYWORDS = ['申诉', '取消扣分', '不公平', '误判', '恢复', '投诉', '举报'];
const SOP_KEYWORDS = ['SOP', '赔付', '退款', '培训', '入职培训', '课件', '带教', '讲师', '考核培训', '技能培训', '标准作业'];

// Agent name prefix mapping
const AGENT_PREFIX = {
  data_auditor: 'BI',           // 数据审计员前缀
  ops_supervisor: 'OP',         // 营运督导员前缀  
  chief_evaluator: 'HR',       // HR专员前缀
  train_advisor: 'Train，请一起操作', // 培训与标准顾问前缀
  sop_advisor: 'Train，请一起操作',   // 兼容旧标识
  appeal: 'REF',                // 申诉处理员前缀
  master: 'Master',             // 调度中枢前缀
  general: 'HRMS'               // 通用前缀
};

export function prefixWithAgentName(route, text) {
  const prefix = AGENT_PREFIX[route] || 'HRMS';
  return `${prefix}：${text}`;
}

async function routeMessage(text, hasImage, senderUsername) {
  const t = String(text || '').trim();
  if (hasImage) return { route: 'ops_supervisor' };
  
  // 快速通行：如果是单数字选项回复，直接返回general供后续继承历史路由
  if (/^\d+$/.test(t) || /^[一二三四五六七八九十]$/.test(t)) return { route: 'general' };

  // 获取最近的对话历史作为上下文（近30分钟内的最后3条非系统消息）
  let contextStr = '';
  if (senderUsername) {
    try {
      const historyRes = await pool().query(
        `SELECT content_text, direction FROM agent_messages WHERE sender_username = $1 AND content_type IN ('text', 'image') AND created_at > NOW() - INTERVAL '30 minutes' ORDER BY created_at DESC LIMIT 3`,
        [senderUsername]
      );
      if (historyRes.rows && historyRes.rows.length > 0) {
        const msgs = historyRes.rows.reverse().map(r => `${r.direction === 'in' ? '用户' : 'Agent'}: ${r.content_text}`);
        contextStr = `\n【最近对话上下文】\n${msgs.join('\n')}\n`;
      }
    } catch (e) {
      console.error('[route] history fetch error:', e?.message);
    }
  }

  const systemPrompt = `你是HRMS系统的主控路由Agent (Master Agent)。
你的唯一任务是根据用户的输入和对话上下文，决定将其路由给哪个专业的子Agent处理。
请严格输出JSON格式，必须包含以下三个字段，不要输出任何其他Markdown或散文：
{
  "route": "目标Agent标识符",
  "confidence": 0到1之间的置信度分数,
  "reason": "路由的简短理由，如果confidence低于0.7，请在这里填入反问用户的澄清话术（例如：您是想咨询财务问题还是技术问题？）"
}

可用Agent标识符及职责：
- data_auditor : 负责【数据审计】，如查询门店营收、毛利率、损耗、盘点、成本、差评数据、充值等数据分析。
- ops_supervisor : 负责【营运督导】，如开市收市检查、卫生巡检、图片审核、日常巡店检查表。
- chief_evaluator : 负责【HR与绩效】，如查询个人绩效分数、考核扣分、门店评级，以及离职、入职、请假、加薪等HR人事流程与制度咨询。
- train_advisor : 负责【培训与SOP】，如查阅SOP规范、操作指导、退款赔付流程，以及发起培训、查询课件、员工带教。
- appeal : 负责【申诉与投诉】，如员工对处罚扣分不服的申诉、对店长或同事的投诉举报。
- general : 如果无法明确归类到以上5个专业领域，或者只是简单的闲聊打招呼。

【Few-Shot 示例】
示例1:
用户输入: "我登不上系统了"
输出: {"route": "general", "confidence": 0.9, "reason": "系统登录问题不属于当前5个专业Agent，交由general处理"}
示例2:
用户输入: "我要投诉"
输出: {"route": "appeal", "confidence": 0.95, "reason": "明确包含投诉意图"}
示例3:
【最近对话上下文】
用户: 我要投诉
Agent: 请问你要投诉谁？
用户输入: "店长"
输出: {"route": "appeal", "confidence": 0.95, "reason": "结合上下文，用户在回复投诉对象，继续申诉流程"}
示例4:
用户输入: "帮我查一下那个单子"
输出: {"route": "general", "confidence": 0.4, "reason": "请问您是要查营收数据单、培训单，还是考勤异常单？"}
${contextStr}
当前用户输入: "${t}"
请严格返回JSON：`;

  try {
    const llm = await callLLM([
      { role: 'system', content: systemPrompt }
    ], { temperature: 0.1, max_tokens: 150 }); // 增加token以容纳JSON
    
    let resultText = String(llm.content || '').trim();
    // 移除可能包裹的 markdown JSON 标记
    resultText = resultText.replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
    
    let result;
    try {
      result = JSON.parse(resultText);
    } catch (parseError) {
      console.error('[route] JSON parse failed, text:', resultText);
      return { route: 'general' };
    }
    
    const validRoutes = ['data_auditor', 'ops_supervisor', 'chief_evaluator', 'train_advisor', 'appeal', 'general'];
    
    // 置信度过滤
    if (result.confidence < 0.7 && result.reason) {
      return { route: 'clarify', message: result.reason };
    }
    
    if (validRoutes.includes(result.route)) {
      return { route: result.route };
    }
    return { route: 'general' };
  } catch (e) {
    console.error('[route] LLM routing failed, fallback to general:', e?.message);
    return { route: 'general' };
  }
}

// ─────────────────────────────────────────────
// 10. Agent Response Generator
// ─────────────────────────────────────────────

async function handleAgentMessage(senderUsername, senderName, senderStore, senderRole, senderBrandContext, text, imageUrls) {
  const hasImage = Array.isArray(imageUrls) && imageUrls.length > 0;
  let routeRes = await routeMessage(text, hasImage, senderUsername);
  let route = routeRes.route;
  
  if (route === 'clarify') {
    return prefixWithAgentName('master', routeRes.message || '请问您具体想咨询哪个方面的问题？');
  }

  const store = senderStore;
  
  // 【修复】继承上一轮的 Agent，解决多轮对话中断（例如用户回复选项 1, 2）的问题
  // 仅继承5分钟内的最近一条非general路由，避免跨对话污染
  if (route === 'general' && (/^\d+$/.test(text) || /^[一二三四五六七八九十]$/.test(text))) {
    try {
      const lastRouteResult = await pool().query(
        `SELECT routed_to FROM agent_messages WHERE sender_username = $1 AND direction = 'in' AND content_type IN ('text','image') AND routed_to IS NOT NULL AND routed_to != 'general' AND created_at > NOW() - INTERVAL '5 minutes' ORDER BY created_at DESC LIMIT 1`,
        [senderUsername]
      );
      if (lastRouteResult.rows && lastRouteResult.rows.length > 0) {
        route = lastRouteResult.rows[0].routed_to;
        console.log(`[route] Inherited recent route: ${route} for short input: ${text}`);
      }
    } catch (e) {
      console.error('[route] inherit route error:', e?.message);
    }
  }

  // 检查是否为培训任务审批（管理员审核下发）
  if (text.includes('审核通过') && text.includes('下发') && (senderRole === 'admin' || senderRole === 'hr_manager')) {
    const pendingTasks = await pool().query(
      `SELECT * FROM training_tasks WHERE status = 'pending_approval' ORDER BY updated_at DESC LIMIT 1`
    );
    if (pendingTasks.rows && pendingTasks.rows.length > 0) {
      const task = pendingTasks.rows[0];
      await pool().query(`UPDATE training_tasks SET status = 'pending', updated_at = NOW() WHERE id = $1`, [task.id]);
      return `已将【${task.title}】的培训任务加入调度队列，Master 将尽快推送给 ${task.assignee_username} 进行学习。`;
    }
  }

  // 检查是否为培训考核消息
  if (text.includes('开始考核') || text.includes('培训考核')) {
    const tasks = await pool().query(
      `SELECT * FROM training_tasks WHERE assignee_username = $1 AND status = 'in_progress' ORDER BY created_at DESC LIMIT 1`,
      [senderUsername]
    );
    if (tasks.rows && tasks.rows.length > 0) {
      const task = tasks.rows[0];
      return `收到！您正在进行【${task.title}】的考核。请回答以下问题：\n\n1. 针对本课程，您认为最重要的三个实操要点是什么？\n2. 在实际工作场景中，您会如何应用所学内容？\n\n请直接回复您的答案，我将为您进行评估。`;
    }
  }

  // 检查是否为培训答卷提交
  if (text.includes('1.') && text.includes('2.') && route === 'train_advisor') {
    const tasks = await pool().query(
      `SELECT * FROM training_tasks WHERE assignee_username = $1 AND status = 'in_progress' ORDER BY created_at DESC LIMIT 1`,
      [senderUsername]
    );
    if (tasks.rows && tasks.rows.length > 0) {
      const task = tasks.rows[0];
      
      // Train Agent 评估成绩（这里简化逻辑，通常可以用 LLM 评估）
      const passed = text.length > 20; // 简单判断回答字数
      
      if (passed) {
        // 更新任务状态为已完成
        await pool().query(
          `UPDATE training_tasks SET status = 'completed', completed_at = NOW(), progress_data = jsonb_set(progress_data, '{exam_answer}', $1::jsonb) WHERE id = $2`,
          [JSON.stringify(text), task.id]
        );
        
        // 将结果记入个人档案 (写入 exam_results)
        await pool().query(
          `INSERT INTO exam_results (user_key, score, pass, created_at) VALUES ($1, $2, $3, NOW())`,
          [senderUsername, 100, true]
        );

        // 反馈给 Chief Evaluator，增加绩效积分 (写入 master_tasks 作为加分项)
        const evalTaskId = `EVAL-${Date.now().toString().slice(-6)}-${Math.random().toString(36).slice(2, 6)}`;
        await pool().query(
          `INSERT INTO master_tasks (task_id, status, source, category, severity, store, brand, title, assignee_username, score_impact, current_agent)
           VALUES ($1, 'settled', 'train_agent', '培训加分', 'low', $2, $3, $4, $5, 5, 'chief_evaluator')`,
          [evalTaskId, task.store, task.brand, `完成培训考核：${task.title}`, senderUsername]
        );

        return `✅ 恭喜您，【${task.title}】考核通过！\n\n您的评估结果已记入 HRMS 个人培训档案，并将同步反馈至您的当周绩效中（+5分）。继续保持！`;
      } else {
        return `❌ 【${task.title}】考核未通过。\n\n您的回答过于简短，请结合实际工作场景，重新详细回答以上两个问题。`;
      }
    }
  }

  // 检查是否为毛利率消息
  if (text.includes('毛利率') && text.includes('%')) {
    try {
      const result = await handleMarginMessage(text);
      if (result.success) {
        return `毛利率数据已收到并保存：${JSON.stringify(result)}`;
      }
    } catch (e) {
      console.error('[agents] margin message error:', e?.message);
    }
  }
  
  const brand = String(senderBrandContext?.brandName || '').trim();
  const brandId = String(senderBrandContext?.brandId || '').trim();
  const brandTag = brandId ? `brand:${brandId}` : '';
  const brandConfig = getBrandRuntimeConfig(await getSharedState(), senderBrandContext);

  let response = '';
  let agentData = { route, brandId, brandConfig };

  try {
    switch (route) {
      case 'data_auditor': {
        // 先查异常数据作为上下文
        let issueContext = '';
        try {
          const issuesR = await pool().query(
            `SELECT severity, title, created_at FROM agent_issues WHERE store = $1 AND status != 'resolved' ORDER BY created_at DESC LIMIT 5`, [store]
          );
          if (issuesR.rows?.length) {
            issueContext = '\n\n当前门店未解决的审计异常：\n' + issuesR.rows.map((i, idx) => `${idx+1}. [${i.severity}] ${i.title}`).join('\n');
          }
        } catch (e) {}

        const biLlm = await callLLM([
          { role: 'system', content: `你是餐饮企业数据审计专员（BI Agent），负责门店数据分析、异常检测和审计。当前门店：${store}（${brand}）。用户：${senderName}（${senderRole === 'store_manager' ? '店长' : senderRole === 'store_production_manager' ? '出品经理' : '员工'}）。\n\n你的职责：\n- 损耗分析、盘点数据、毛利率监控\n- 营收对账、成本异常检测\n- 差评数据分析\n- 充值数据追踪\n\n${issueContext}\n\n请根据用户问题，结合门店实际数据给出专业、简洁的分析和建议。如果用户问的是具体数据，尽量给出结构化回复。回复不超过300字。` },
          ...getContext(senderUsername).slice(-4),
          { role: 'user', content: text }
        ]);
        response = biLlm.content || '收到，我会查看门店数据并尽快回复。';
        updateContext(senderUsername, 'user', text);
        updateContext(senderUsername, 'assistant', response);
        agentData = { route, store, brand, brandId, brandConfig };
        break;
      }

      case 'ops_supervisor': {
        if (hasImage) {
          const auditResults = [];
          for (const imgUrl of imageUrls) {
            const result = await auditImage(imgUrl, 'general', { store, brand, username: senderUsername });
            auditResults.push(result);
          }
          const anyDuplicate = auditResults.some(r => r.duplicate);
          const allPass = auditResults.every(r => r.result === 'pass');
          const anyFail = auditResults.some(r => r.result === 'fail');

          if (anyDuplicate) {
            response = `⚠️ 检测到重复图片，请重新拍摄并上传。系统已记录此次异常。`;
          } else if (allPass) {
            const summaries = auditResults.map(r => r.findings).filter(Boolean).join('；');
            response = `收到，照片识别合格 ✅\n${summaries || '图片内容符合要求。'}\n已记录整改措施，感谢配合。`;
          } else if (anyFail) {
            const failFindings = auditResults.filter(r => r.result === 'fail').map(r => r.findings).join('；');
            response = `照片审核未通过 ❌\n${failFindings}\n请整改后重新拍照上传。`;
          } else {
            response = `照片已收到，正在审核中。部分图片无法自动判定，已转交值班经理人工复核。`;
          }
          agentData = { route, auditResults, brandId, brandConfig };
        } else {
          let knowledgeSupport = null;
          // 检查是否为检查表请求
          let checklistResponse = '';
          
          if (text.includes('开市') || text.includes('开档')) {
            const brandChecklist = brand === '洪潮' 
              ? '地面清洁无积水、所有设备正常开启、食材新鲜度检查、餐具消毒完成、灯光亮度适中、背景音乐开启、空调温度设置合适、员工仪容仪表检查'
              : brand === '马己仙'
              ? '地面清洁、设备开启、食材准备、餐具消毒、迎宾准备'
              : '地面清洁、设备开启、食材准备、餐具消毒';
            checklistResponse = `【开市检查表 - ${brand}】\n请逐项检查并拍照反馈：\n${brandChecklist.split('、').map(item => `✅ ${item}`).join('\n')}\n\n完成后请发送各项目检查照片。`;
          } else if (text.includes('收档') || text.includes('闭市') || text.includes('收市')) {
            const brandChecklist = brand === '洪潮'
              ? '食材封存、设备关闭、垃圾清理、安全检查、门窗锁好'
              : brand === '马己仙'
              ? '食材封存、设备关闭、垃圾清理、安全检查、门窗锁好、电源关闭'
              : '食材封存、设备关闭、垃圾清理、安全检查';
            checklistResponse = `【收档检查表 - ${brand}】\n请逐项检查并拍照反馈：\n${brandChecklist.split('、').map(item => `✅ ${item}`).join('\n')}\n\n完成后请发送各项目检查照片。`;
          } else if (text.includes('巡检')) {
            checklistResponse = `【营运巡检要求】\n请检查以下项目并拍照反馈：\n✅ 大厅环境整洁\n✅ 服务台规范\n✅ 卫生间清洁\n✅ 后厨卫生\n✅ 安全设施\n\n请发送各区域检查照片。`;
          }
          
          if (checklistResponse) {
            response = checklistResponse;
          } else {
            // 检查是否需要知识支援
            knowledgeSupport = await getOpsKnowledgeSupport(text, { store, brand });
            
            if (knowledgeSupport.type === 'standard' || knowledgeSupport.type === 'knowledge_base') {
              response = knowledgeSupport.response;
            } else {
              // 使用LLM生成专业回复
              const llm = await callLLM([
                { role: 'system', content: `你是餐饮营运督导员，当前门店：${store}（${brand}，brand_id=${brandId || 'n/a'}）。简洁专业，注重实操。` },
                { role: 'user', content: text }
              ]);
              response = llm.content || '收到，我会跟进处理。';
            }
          }
          
          agentData = { route, knowledgeSupport: knowledgeSupport?.type, brandId, brandConfig };
        }
        break;
      }

      case 'chief_evaluator': {
        // 判断是否在问绩效分数（走数据查询），还是HR流程问题（走LLM）
        const isScoreQuery = /分数|绩效|考核|得分|扣分|排名|评价|评级|奖金/.test(text);
        
        if (isScoreQuery) {
          // 绩效查询：查数据库
          const scoresR = await pool().query(
            `SELECT * FROM agent_scores WHERE username = $1 ORDER BY created_at DESC LIMIT 1`, [senderUsername]
          );
          const score = scoresR.rows?.[0];
          if (score) {
            const bd = score.breakdown || {};
            const storeRatingText = bd.store_rating ? `${bd.store_rating}级` : '-';
            const execRatingText = bd.execution_rating ? `${bd.execution_rating}级` : '-';
            const attRatingText = bd.attitude_rating ? `${bd.attitude_rating}级` : '-';
            const abiRatingText = bd.ability_rating ? `${bd.ability_rating}级` : '-';
            
            response = `HR: ${senderName}，你在${score.store}（${score.brand}）的最新考核：\n\n📊 绩效得分：${score.total_score} 分\n🏪 门店评级：${storeRatingText}\n📈 执行力：${execRatingText}\n💪 工作态度：${attRatingText}\n🎯 工作能力：${abiRatingText}\n\n${score.summary || ''}`;
          } else {
            response = `${senderName}，暂无你的考核记录。考核将在月末自动生成。`;
          }
        } else {
          // HR流程问题：用LLM回答（带Check Agent质检）
          const hrSystemPrompt = `你是餐饮企业HR专员（HR Agent），负责人事管理和员工服务。当前门店：${store}（${brand}）。用户：${senderName}（${senderRole === 'store_manager' ? '店长' : senderRole === 'store_production_manager' ? '出品经理' : '员工'}）。\n\n你的职责：\n- 离职流程指引（提交申请→审批→交接→结算）\n- 入职/转正/晋升/调岗流程\n- 薪资/加薪咨询（需走审批流程）\n- 请假/休假/考勤政策\n- 社保/档案/人事制度\n- 绩效考核规则说明\n\n请根据用户问题给出专业、简洁、有温度的回复。涉及具体流程时，分步骤说明。回复不超过300字。`;
          const hrContext = getContext(senderUsername).slice(-4);
          response = await runWithCheckAgent(text, 'chief_evaluator', async (checkFeedback) => {
            const extraNote = checkFeedback ? `\n\n【质检反馈，请修正后重新回答】${checkFeedback}` : '';
            const hrLlm = await callLLM([
              { role: 'system', content: hrSystemPrompt + extraNote },
              ...hrContext,
              { role: 'user', content: text }
            ]);
            return hrLlm.content || '收到，我会为您查询相关信息并尽快回复。';
          });
          updateContext(senderUsername, 'user', text);
          updateContext(senderUsername, 'assistant', response);
        }
        agentData = { route, brandId, brandConfig };
        break;
      }

      case 'appeal': {
        const appealSystemPrompt = `你是餐饮企业投诉与申诉处理专员。你负责处理两类事务：
1. 投诉（对店长、同事、服务等的投诉）：确认投诉内容，说明将转交相关负责人核实，保护投诉人隐私，给出处理流程和预计时间。
2. 申诉（对绩效扣分、处罚等的申诉）：确认申诉内容，说明将核实数据，给出预计处理时间。
回复要专业、公正、有温度，极其简短。如果用户回复数字选项，根据上下文理解用户选择并给出对应回复。`;
        const appealContext = getContext(senderUsername);
        const appealUserMsg = `${senderName}（${store}门店，${senderRole === 'store_manager' ? '店长' : senderRole === 'store_production_manager' ? '出品经理' : '员工'}）说：${text}`;
        response = await runWithCheckAgent(text, 'appeal', async (checkFeedback) => {
          const extraNote = checkFeedback ? `\n\n【质检反馈，请修正后重新回答】${checkFeedback}` : '';
          const llm = await callLLM([
            { role: 'system', content: appealSystemPrompt + extraNote },
            ...appealContext,
            { role: 'user', content: appealUserMsg }
          ]);
          return llm.content || '已记录，我们将在24小时内核实并回复。';
        });
        try {
          await pool().query(`INSERT INTO agent_appeals (username, reason, status) VALUES ($1, $2, 'pending')`, [senderUsername, text]);
        } catch (e) {}
        agentData = { route, appealRecorded: true };
        break;
      }

      case 'train_advisor':
      case 'sop_advisor': {
        // Query knowledge base for relevant SOP & training content
        let kbContext = '';
        let kbResults = [];
        try {
          kbResults = await queryKnowledgeBase(['sop', '流程', '标准', '规范', '培训', '课件', '带教'], text, 3, { brandTag });
          if (kbResults.length) {
            kbContext = '\n\n相关知识库内容：\n' + 
              kbResults.map(r => `【${r.title}】${String(r.content || '').slice(0, 300)}...`).join('\n');
          }
        } catch (e) {}

        // 查阅该用户的培训记录
        let trainingTasksContext = '';
        try {
          const tasks = await pool().query(
            `SELECT task_id, type, title, status, due_date, progress_data FROM training_tasks 
             WHERE assignee_username = $1 ORDER BY created_at DESC LIMIT 5`,
            [senderUsername]
          );
          if (tasks.rows && tasks.rows.length > 0) {
            trainingTasksContext = '\n\n该用户近期的培训任务：\n' + tasks.rows.map(t => 
              `- [${t.task_id}] ${t.title} (${t.type}) | 状态：${t.status} | 截止：${t.due_date ? new Date(t.due_date).toLocaleDateString() : '无'}`
            ).join('\n');
          }
        } catch (e) {
          console.error('[train_advisor] fetch training tasks error:', e?.message);
        }

        // 构建增强的prompt（SOP + 培训双能力）
        const trainingFocusText = brandConfig?.trainingFocus?.length ? `\n品牌培训重点：${brandConfig.trainingFocus.join('；')}` : '';
        const systemPrompt = `你是餐饮企业培训与标准化专家顾问（Train Agent），同时精通SOP标准咨询和培训体系管理。严格执行品牌隔离。${brandConfig?.sopKeypoints?.length ? `\n品牌SOP关键点：${brandConfig.sopKeypoints.join('；')}` : ''}${trainingFocusText}

你的核心能力：
【SOP标准咨询】流程规范查询、操作指导、赔付退款处理、品牌差异化SOP
【培训战略体系】制定培训战略、搭建人才发展与梯队培养框架、领导力发展、管培生/内训师体系设计、年度培训预算与计划、对接业务部门做培训需求分析、主导管理层培训与关键岗位赋能、企业文化落地、管理培训团队与讲师资源、评估培训效果与ROI
【基础培训执行】组织新员工入职培训与岗位技能培训、制作整理更新培训课件资料、安排培训场地设备签到与现场支持、收集培训反馈记录培训数据归档、协助完成培训计划与通知下发、对接讲师学员保障培训正常开展
【培训跟踪评估】跟进员工的培训任务进度，解答培训过程中的疑惑，进行线上知识考核与效果评估

当前信息：
- 门店：${store}（${brand}，brand_id=${brandId || 'n/a'}）
- 用户：${senderName}（${senderUsername}，角色：${senderRole}）
- 查询：${text}

${kbContext}${trainingTasksContext}

请根据问题类型选择合适的回复结构：
如果是SOP/流程问题：
1. **问题判断**：简要确认理解的问题
2. **标准流程**：分步骤说明具体操作（1-2-3格式）
3. **注意事项**：关键提醒和常见错误
4. **参考依据**：相关SOP条款或标准

如果是培训咨询/任务问题：
1. **进度跟进**：结合用户的培训任务，指出当前进度或待办
2. **专业解答**：解答用户关于课件或技能的疑惑
3. **下一步建议**：给出接下来的学习或实操建议
4. **效果评估**：如果是完成阶段，可以向用户提问1-2个关键知识点进行检验

要求：简洁实用，总回复不超过400字。`;

        const contextHistory = getContext(senderUsername);
        const messages = [
          { role: 'system', content: systemPrompt },
          ...contextHistory.slice(-4), // 最近4轮对话
          { role: 'user', content: text }
        ];

        const llm = await callLLM(messages, { temperature: 0.05, max_tokens: 800 });
        response = llm.content || '这个问题我需要查阅最新的SOP手册或培训资料，稍后回复你。';
        
        // 更新上下文
        updateContext(senderUsername, 'user', text);
        updateContext(senderUsername, 'assistant', response);
        
        agentData = { route: 'train_advisor', kbResults: kbResults.length, contextUsed: contextHistory.length, brandId, brandConfig };
        break;
      }

      default: {
        const roleText = senderRole === 'store_manager' ? '店长' : senderRole === 'store_production_manager' ? '出品经理' : '员工';

        const llm = await callLLM([
          { role: 'system', content: `你是餐饮门店数字助理，服务于${store}（${brand}，brand_id=${brandId || 'n/a'}）。当前用户是${roleText}（${senderName}）。可以帮助：数据审计、营运检查、绩效查询、SOP咨询、申诉处理。回复需极其简短，最多提供带emoji的数字编号选项供用户选择。` },
          ...getContext(senderUsername),
          { role: 'user', content: text }
        ]);
        response = llm.content || '收到你的消息。你可以问我数据审计、营运检查、绩效考核等问题，也可以直接发照片给我审核。';
        agentData = { route: 'general', contextUsed: getContext(senderUsername).length, brandId };
        break;
      }
    }
  } catch (e) {
    console.error('[agents] handleAgentMessage error:', e?.message || e);
    response = '抱歉，处理消息时出现错误，请稍后重试。';
    agentData = { route, error: String(e?.message || e) };
  }

  return { route, response, agentData };
}

// ─────────────────────────────────────────────
// 11. Check Agent - Self-Reflection Quality Gate
// ─────────────────────────────────────────────

async function checkAgentAudit(userQuery, agentResponse, route) {
  const auditPrompt = `你是HRMS系统的质检Agent（Check Agent）。你的任务是审核子Agent的回答质量。

【用户问题】
${userQuery}

【子Agent（${route}）的回答】
${agentResponse}

请从以下3个维度评分（每项1-10分），并给出综合判断：
1. **准确性**：回答是否基于事实，有无幻觉或编造内容？
2. **相关性**：回答是否真正解决了用户的问题？
3. **语气**：语气是否专业、得当、不冷漠也不过度？

请严格输出JSON格式：
{
  "accuracy": 分数,
  "relevance": 分数,
  "tone": 分数,
  "total": 综合分数(三项平均),
  "pass": true或false（total>=7为pass）,
  "feedback": "如果不通过，给出具体的修改建议，指出哪里有问题以及如何改进"
}`;

  try {
    const llm = await callLLM([
      { role: 'system', content: auditPrompt }
    ], { temperature: 0.1, max_tokens: 300 });

    let text = String(llm.content || '').trim()
      .replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
    return JSON.parse(text);
  } catch (e) {
    console.error('[check_agent] audit error:', e?.message);
    return { pass: true }; // 审核失败时放行，避免阻塞
  }
}

async function runWithCheckAgent(userQuery, route, generateFn, maxRetries = 2) {
  let response = await generateFn(null);
  
  // 仅对关键Agent启用Check Agent（避免增加general/ops的延迟）
  const checkEnabledRoutes = ['chief_evaluator', 'data_auditor', 'appeal', 'train_advisor'];
  if (!checkEnabledRoutes.includes(route)) return response;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const audit = await checkAgentAudit(userQuery, response, route);
    console.log(`[check_agent] route=${route} attempt=${attempt + 1} pass=${audit.pass} total=${audit.total}`);
    
    if (audit.pass !== false) break; // 通过则直接返回

    // 不通过：带着 Check Agent 的反馈让子 Agent 重写
    console.log(`[check_agent] rewriting: ${audit.feedback}`);
    response = await generateFn(audit.feedback);
  }

  return response;
}

let _bitablePollingInterval = null;

export function startBitablePolling(intervalMs = 60000) {
  if (_bitablePollingInterval) {
    clearInterval(_bitablePollingInterval);
  }
  
  console.log('[bitable] starting multi-config polling with interval:', intervalMs, 'ms');
  
  // 立即执行一次
  pollAllBitableSubmissions().catch(console.error);
  
  // 设置定时器
  _bitablePollingInterval = setInterval(() => {
    pollAllBitableSubmissions().catch(console.error);
  }, intervalMs);
  
  // 启动归档定时任务（每天检查一次）
  startArchiveScheduler();
}

export function startArchiveScheduler() {
  // 每天凌晨 3 点执行归档
  const scheduleNextArchive = () => {
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(3, 0, 0, 0);
    
    const msUntilArchive = tomorrow.getTime() - now.getTime();
    
    setTimeout(async () => {
      console.log('[bitable] running daily archive task');
      const result = await archiveOldBitableSubmissions();
      console.log('[bitable] archive result:', result);
      
      // 检查容量告警
      await checkBitableCapacity();
      
      // 递归调度下一次
      scheduleNextArchive();
    }, msUntilArchive);
    
    console.log('[bitable] next archive scheduled for:', tomorrow.toISOString());
  };
  
  scheduleNextArchive();
}

export async function checkBitableCapacity() {
  try {
    const stats = await getBitableSubmissionStats();
    const mainCount = stats.main.total || 0;
    const totalCount = stats.total || 0;
    
    console.log(`[bitable] capacity check: main=${mainCount}, total=${totalCount}`);
    
    // 容量告警（调整阈值）
    if (mainCount > 1000) {
      const warning = `⚠️ Bitable 容量提醒\n主表记录数：${mainCount}/2000\n总记录数：${totalCount}\n系统已启用自动归档，7天后数据移至归档表，60天后自动删除`;
      console.warn('[bitable] CAPACITY WARNING:', warning);
      // await sendLarkMessage(adminOpenId, prefixWithAgentName('system', warning));
    }
    
    if (mainCount > 1500) {
      const critical = `🚨 Bitable 容量预警\n主表记录数：${mainCount}/2000\n系统将自动清理旧数据，无需手动干预`;
      console.error('[bitable] CAPACITY CRITICAL:', critical);
      // await sendLarkMessage(adminOpenId, prefixWithAgentName('system', critical));
    }
    
  } catch (e) {
    console.error('[bitable] capacity check failed:', e?.message);
  }
}

export function stopBitablePolling() {
  if (_bitablePollingInterval) {
    clearInterval(_bitablePollingInterval);
    _bitablePollingInterval = null;
    console.log('[bitable] polling stopped');
  }
}

// ─────────────────────────────────────────────
// 13. Feishu Webhook Event Handler
// ─────────────────────────────────────────────

// Dedup: track processed event IDs (in-memory, last 500)
const _processedEvents = new Set();
const _processedEventsQueue = [];
function markEventProcessed(eventId) {
  if (_processedEvents.size > 500) {
    const old = _processedEventsQueue.shift();
    _processedEvents.delete(old);
  }
  _processedEvents.add(eventId);
  _processedEventsQueue.push(eventId);
}

async function tryCaptureOpsChecklistDetailFromChat(openId, feishuUser, text, imageUrls) {
  const storeName = String(feishuUser?.store || '').trim();
  if (!openId || !storeName) return { handled: false };

  const candidates = [];
  const today = new Date().toISOString().slice(0, 10);
  candidates.push(`${openId}||${storeName}||opening||${today}`);
  candidates.push(`${openId}||${storeName}||closing||${today}`);

  let matchedKey = '';
  let progress = null;
  for (const key of candidates) {
    const p = _opsChecklistProgress.get(key);
    if (p && Number.isFinite(p.pendingItemIndex) && p.pendingItemIndex >= 0) {
      matchedKey = key;
      progress = p;
      break;
    }
  }
  if (!progress) return { handled: false };

  const idx = progress.pendingItemIndex;
  const itemName = String(progress.pendingItemName || '').trim() || `第${idx + 1}项`;
  if (!progress.itemDetails[idx]) progress.itemDetails[idx] = { status: '', remark: '', photoCount: 0 };

  let changed = false;
  if (text) {
    const normalized = text.replace(/^说明[：:]/, '').trim();
    if (normalized) {
      progress.itemDetails[idx].remark = normalized;
      changed = true;
    }
  }
  if (Array.isArray(imageUrls) && imageUrls.length) {
    progress.itemDetails[idx].photoCount = (Number(progress.itemDetails[idx].photoCount) || 0) + imageUrls.length;
    changed = true;
  }

  if (!changed) return { handled: false };

  const abnormalCount = countOpsChecklistAbnormal(progress);
  const detail = progress.itemDetails[idx] || {};
  const statusText = detail.status === 'pass' ? '合格' : detail.status === 'fail' ? '异常' : '未标记';
  const remarkText = String(detail.remark || '').trim() ? '已填写' : '未填写';
  const photoText = `${Number(detail.photoCount) || 0}张`;

  await sendLarkMessage(
    openId,
    prefixWithAgentName('ops_supervisor', `已更新【${itemName}】\n状态：${statusText}\n说明：${remarkText}\n照片：${photoText}\n\n当前已记录异常：${abnormalCount}项`)
  );

  return { handled: true, progressKey: matchedKey, abnormalCount };
}

export async function onFeishuEvent(body) {
  // URL verification challenge
  if (body?.type === 'url_verification' || body?.challenge) {
    console.log('[feishu] URL verification challenge received');
    return { challenge: body.challenge };
  }

  const header = body?.header || {};
  const event = body?.event || {};
  const eventId = String(header?.event_id || '').trim();
  const eventType = String(header?.event_type || '').trim();

  // Dedup
  if (eventId && _processedEvents.has(eventId)) {
    return { ok: true, dedup: true };
  }
  if (eventId) markEventProcessed(eventId);

  console.log('[feishu] event:', eventType, 'id:', eventId);

  if (eventType === 'card.action.trigger') {
    return await handleOpsChecklistCardAction(event);
  }

  if (eventType === 'im.message.receive_v1') {
    const msg = event?.message || {};
    const sender = event?.sender || {};
    const msgType = String(msg?.message_type || '').trim();
    const messageId = String(msg?.message_id || '').trim();
    const chatType = String(msg?.chat_type || '').trim();
    const openId = String(sender?.sender_id?.open_id || '').trim();

    if (!openId) return { ok: true, skipped: 'no_sender' };
    // Only handle private (single chat) messages - accept both 'private' and 'p2p'
    if (chatType !== 'private' && chatType !== 'p2p') {
      console.log('[feishu] skipping non-private message, chat_type:', chatType);
      return { ok: true, skipped: 'not_private' };
    }

    // ── Check user registration ──
    let feishuUser = await lookupFeishuUser(openId);

    if (!feishuUser || !feishuUser.registered) {
      // Parse text
      let inputText = '';
      if (msgType === 'text') {
        try { inputText = String(JSON.parse(msg?.content || '{}').text || '').trim(); } catch (e) { inputText = String(msg?.content || '').trim(); }
      }

      if (inputText) {
        // Try to register with the text as username
        const regResult = await registerFeishuUser(openId, inputText);
        if (regResult.ok) {
          const u = regResult.user;
          await sendLarkMessage(openId,
            `✅ 绑定成功！${u.name || u.username}（${u.store || ''}），你好！\n\n我是HRMS智能助理，可以帮你：\n📊 查数据 — "昨天损耗多少？""差评情况？"\n📷 审图片 — 直接发照片，我帮你审核卫生/出品\n📈 看绩效 — "我这周考核分多少？"\n📖 问SOP — "外卖漏发餐具怎么赔付？"\n✋ 申诉 — "申诉昨天损耗扣分，原因是停电"\n\n现在就可以开始对话了！`
          );
          return { ok: true, registered: true, username: u.username };
        }
      }

      // Save unregistered user record
      try {
        await pool().query(
          `INSERT INTO feishu_users (open_id, registered) VALUES ($1, FALSE) ON CONFLICT (open_id) DO NOTHING`, [openId]
        );
      } catch (e) {}

      await sendLarkMessage(openId,
        `你好！我是HRMS智能助理 🤖\n\n首次使用需要绑定HRMS账号。\n请输入你的HRMS用户名（登录HRMS系统时使用的用户名）：`
      );
      return { ok: true, pendingRegistration: true };
    }

    // ── User is registered, process message ──
    let text = '';
    let imageUrls = [];

    if (msgType === 'text') {
      try { text = String(JSON.parse(msg?.content || '{}').text || '').trim(); } catch (e) { text = String(msg?.content || '').trim(); }
      // Remove @bot mention text
      if (msg?.mentions?.length) {
        for (const m of msg.mentions) {
          text = text.replace(new RegExp(`@${m.name || ''}`, 'g'), '').trim();
        }
      }
    } else if (msgType === 'image') {
      try {
        const content = JSON.parse(msg?.content || '{}');
        const imageKey = content?.image_key || '';
        if (imageKey && messageId) {
          console.log('[feishu] downloading image:', imageKey);
          const imgUrl = await getLarkImageUrl(messageId, imageKey);
          if (imgUrl) imageUrls.push(imgUrl);
        }
      } catch (e) { console.error('[feishu] parse image failed:', e?.message); }
    } else if (msgType === 'audio') {
      // Voice message — acknowledge and ask for text
      await sendLarkMessage(openId, '收到语音消息。目前暂不支持语音识别，请用文字描述你的问题，我会尽快处理。');
      return { ok: true, skipped: 'audio_not_supported' };
    } else {
      await sendLarkMessage(openId, `收到${msgType}消息。目前支持文字和图片，请用文字描述或发送照片。`);
      return { ok: true, skipped: 'unsupported_type' };
    }

    if (!text && !imageUrls.length) return { ok: true, skipped: 'empty' };

    const detailCapture = await tryCaptureOpsChecklistDetailFromChat(openId, feishuUser, text, imageUrls);
    if (detailCapture?.handled) {
      return { ok: true, route: 'ops_supervisor', checklistDetailCaptured: true };
    }

    const checklistType = detectOpsChecklistType(text);
    if (msgType === 'text' && checklistType) {
      const sharedState = await getSharedState();
      const brandContext = resolveBrandContextByStore(sharedState, feishuUser.store || '');
      const storeName = String(feishuUser.store || '').trim();
      const typeLabel = checklistType === 'opening' ? '开市' : '收档';
      
      // 发送 Bitable 表单二维码和链接
      const formUrl = 'https://ycnp8e71t8x8.feishu.cn/base/PtVObRtoPaMAP3stIIFc8DnJngd?table=tblxHI9ZAKONOTpp&view=vewjuqywQu';
      
      // 生成二维码图片
      let qrCard = null;
      try {
        // 使用简单的文本卡片模拟二维码
        qrCard = {
          config: { wide_screen_mode: true },
          header: { title: { tag: 'plain_text', content: `${typeLabel}检查表` }, template: 'blue' },
          elements: [
            {
              tag: 'div',
              text: {
                tag: 'lark_md',
                content: `**门店**：${storeName || '-'}\n**类型**：${typeLabel}\n\n📱 请扫描下方二维码或点击链接填写检查表\n\n🔗 ${formUrl}\n\n✅ 填写完成后系统会自动确认`
              }
            }
          ]
        };
      } catch (e) {
        console.error('[ops] generate qr card failed:', e?.message);
      }
      
      if (qrCard) {
        const cardResult = await sendLarkCard(openId, qrCard);
        if (!cardResult.ok) {
          // 降级到文本消息
          const qrText = `📋 请填写${typeLabel}检查表\n\n🔗 表单链接：${formUrl}\n\n📱 或扫描二维码填写\n（二维码图片请参考群公告）\n\n✅ 填写完成后系统会自动确认\n如有问题请联系管理员`;
          await sendLarkMessage(openId, prefixWithAgentName('ops_supervisor', qrText));
        }
      } else {
        const qrText = `📋 请填写${typeLabel}检查表\n\n🔗 表单链接：${formUrl}\n\n📱 或扫描二维码填写\n（二维码图片请参考群公告）\n\n✅ 填写完成后系统会自动确认\n如有问题请联系管理员`;
        await sendLarkMessage(openId, prefixWithAgentName('ops_supervisor', qrText));
      }

      try {
        await pool().query(
          `INSERT INTO agent_messages (direction, channel, feishu_open_id, sender_username, sender_name, sender_role, routed_to, content_type, content, agent_data)
           VALUES ('out','feishu',$1,$2,$3,$4,'ops_supervisor','bitable_form',$5,$6::jsonb)`,
          [openId, feishuUser.username, feishuUser.name || feishuUser.username, feishuUser.role || '', `${typeLabel}检查表（Bitable表单）`, JSON.stringify({ checklistType, via: 'bitable_form', formUrl })]
        );
      } catch (e) {}

      return { ok: true, route: 'ops_supervisor', bitableForm: true };
    }

    // Log incoming message
    let msgDbId = null;
    try {
      const r = await pool().query(
        `INSERT INTO agent_messages (direction, channel, feishu_open_id, sender_username, sender_name, sender_role, content_type, content, image_urls, feishu_message_id)
         VALUES ('in','feishu',$1,$2,$3,$4,$5,$6,$7::jsonb,$8) RETURNING id`,
        [openId, feishuUser.username, feishuUser.name, feishuUser.role,
         imageUrls.length ? 'image' : 'text', text || '',
         JSON.stringify(imageUrls), messageId]
      );
      msgDbId = r.rows?.[0]?.id;
    } catch (e) {}

    // ── Master Agent: 优先检查是否是任务反馈 ──
    if (_taskResponseHook) {
      try {
        const taskResult = await _taskResponseHook(feishuUser.username, text, imageUrls);
        if (taskResult?.handled) {
          const reply = prefixWithAgentName('master', taskResult.response);
          await sendLarkMessage(openId, reply);
          try {
            if (msgDbId) {
              await pool().query(
                `UPDATE agent_messages SET routed_to='master', agent_response=$1, agent_data=$2::jsonb WHERE id=$3`,
                [taskResult.response, JSON.stringify({ taskId: taskResult.taskId, route: 'master_task' }), msgDbId]
              );
            }
          } catch (e) {}
          return { ok: true, route: 'master', taskId: taskResult.taskId };
        }
      } catch (e) {
        console.error('[feishu] task response hook error:', e?.message);
      }
    }

    // Route and handle
    const sharedState = await getSharedState();
    const brandContext = resolveBrandContextByStore(sharedState, feishuUser.store || '');
    const result = await handleAgentMessage(
      feishuUser.username, feishuUser.name || feishuUser.username,
      feishuUser.store || '', feishuUser.role || '', brandContext,
      text, imageUrls
    );

    // Reply via Feishu (with agent name prefix)
    if (result.response) {
      await sendLarkMessage(openId, prefixWithAgentName(result.route, result.response));
    }

    // Log response
    try {
      if (msgDbId) {
        await pool().query(
          `UPDATE agent_messages SET routed_to=$1, agent_response=$2, agent_data=$3::jsonb WHERE id=$4`,
          [result.route, result.response, JSON.stringify(result.agentData || {}), msgDbId]
        );
      }
    } catch (e) {}

    return { ok: true, route: result.route, responded: !!result.response };
  }

  return { ok: true, unhandled: eventType };
}

// ─────────────────────────────────────────────
// 12. Feishu Push Notifications
// ─────────────────────────────────────────────

// Push new issues to their assignees via Feishu
async function pushIssuesToFeishu() {
  try {
    const r = await pool().query(
      `SELECT ai.id, ai.title, ai.detail, ai.severity, ai.store, ai.category, ai.assignee_username
       FROM agent_issues ai
       WHERE ai.feishu_notified = FALSE AND ai.assignee_username IS NOT NULL
       ORDER BY ai.created_at DESC LIMIT 20`
    );
    if (!r.rows?.length) return 0;

    let pushed = 0;
    for (const issue of r.rows) {
      const fu = await lookupFeishuUserByUsername(issue.assignee_username);
      if (!fu?.open_id) continue;

      const sev = issue.severity === 'high' ? '🔴 高优先级' : '🟡 中优先级';
      const msgText = `${sev} 异常通知\n\n📋 ${issue.title}\n\n${issue.detail || ''}\n\n⏰ 请在1小时内查看并回复整改措施。\n直接回复文字说明整改情况，或发送整改照片。`;
      const msg = prefixWithAgentName('data_auditor', msgText);

      const sendResult = await sendLarkMessage(fu.open_id, msg);
      if (sendResult.ok) {
        await pool().query(`UPDATE agent_issues SET feishu_notified = TRUE WHERE id = $1`, [issue.id]);
        pushed++;

        // Log outbound message
        try {
          await pool().query(
            `INSERT INTO agent_messages (direction, channel, feishu_open_id, sender_username, sender_name, routed_to, content_type, content)
             VALUES ('out','feishu',$1,$2,$3,'data_auditor','text',$4)`,
            [fu.open_id, 'system', 'HRMS Agent', msg]
          );
        } catch (e) {}
      }
    }
    return pushed;
  } catch (e) {
    console.error('[feishu] push issues failed:', e?.message);
    return 0;
  }
}

// Push performance scores to users via Feishu
async function pushScoresToFeishu() {
  try {
    const r = await pool().query(
      `SELECT * FROM agent_scores WHERE feishu_notified = FALSE ORDER BY created_at DESC LIMIT 20`
    );
    if (!r.rows?.length) return 0;

    let pushed = 0;
    for (const score of r.rows) {
      const fu = await lookupFeishuUserByUsername(score.username);
      if (!fu?.open_id) continue;

      const deductions = Array.isArray(score.deductions) ? score.deductions : [];
      const deductionText = deductions.length
        ? deductions.map(d => `  • ${d.category}: ${d.points}分`).join('\n')
        : '  无扣分项';

      const msgText = `📊 绩效考核通知\n\n${fu.name || score.username}，你在${score.store}（${score.brand}）的${score.period}考核结果：\n\n📊 总分：${score.total_score} 分\n📋 模型：${score.score_model}\n${Object.entries(score.breakdown || {}).map(([k, v]) => `  • ${k}: ${v}分`).join('\n')}\n\n扣分明细：\n${deductionText}\n\n${score.summary || ''}\n\n如有异议，请回复"申诉"并说明原因。`;
      const msg = prefixWithAgentName('chief_evaluator', msgText);

      const sendResult = await sendLarkMessage(fu.open_id, msg);
      if (sendResult.ok) {
        await pool().query(`UPDATE agent_scores SET feishu_notified = TRUE WHERE id = $1`, [score.id]);
        pushed++;
      }
    }
    return pushed;
  } catch (e) {
    console.error('[feishu] push scores failed:', e?.message);
    return 0;
  }
}

// ─────────────────────────────────────────────
// 13. Scheduler
// ─────────────────────────────────────────────

let _schedulerStarted = false;

export function startAgentScheduler() {
  if (_schedulerStarted) return;
  _schedulerStarted = true;

  // Data audit + push issues every 30 minutes
  const auditTick = async () => {
    try {
      const result = await runDataAuditor();
      if (result.issuesCreated > 0) {
        console.log(`[scheduler] Data Auditor: ${result.issuesCreated} new issues`);
      }
      // Push new issues to Feishu
      const pushed = await pushIssuesToFeishu();
      if (pushed > 0) console.log(`[scheduler] Pushed ${pushed} issues to Feishu`);
    } catch (e) {
      console.error('[scheduler] audit tick error:', e?.message);
    }
  };

  // Weekly evaluation (Monday 9am) + push scores
  const evalTick = async () => {
    try {
      const now = new Date();
      if (now.getDay() === 1 && now.getHours() === 9) {
        const weekNum = Math.ceil((now.getDate() + new Date(now.getFullYear(), now.getMonth(), 1).getDay()) / 7);
        const period = `${now.getFullYear()}-W${String(weekNum).padStart(2, '0')}`;
        const result = await runChiefEvaluator(period);
        console.log(`[scheduler] Chief Evaluator: ${result.evaluated} staff for ${period}`);

        // Push scores to Feishu
        const pushed = await pushScoresToFeishu();
        if (pushed > 0) console.log(`[scheduler] Pushed ${pushed} scores to Feishu`);
      }
    } catch (e) {
      console.error('[scheduler] eval tick error:', e?.message);
    }
  };

  // OP Agent: 每周一早上10点督办周异常（实收营收、人效值、桌访产品、桌访占比、产品/服务差评）
  const weeklyOpsTick = async () => {
    try {
      const now = new Date();
      // 周一且10点执行
      if (now.getDay() === 1 && now.getHours() === 10 && now.getMinutes() < 5) {
        console.log('[scheduler] OP Agent: 开始督办周异常...');
        
        // 查询过去7天的周异常（未解决的）
        const weeklyCategories = [
          '实收营收异常',
          '人效值异常', 
          '桌访产品异常',
          '桌访占比异常',
          '产品差评异常',
          '服务差评异常'
        ];
        
        const result = await pool().query(
          `SELECT * FROM agent_issues 
           WHERE category = ANY($1) 
             AND status != 'resolved'
             AND created_at >= NOW() - INTERVAL '7 days'
           ORDER BY store, category`,
          [weeklyCategories]
        );
        
        if (result.rows?.length > 0) {
          console.log(`[scheduler] OP Agent: 发现 ${result.rows.length} 条周异常待督办`);
          
          // 按门店分组并发送督办通知
          const byStore = {};
          for (const issue of result.rows) {
            if (!byStore[issue.store]) byStore[issue.store] = [];
            byStore[issue.store].push(issue);
          }
          
          for (const [store, issues] of Object.entries(byStore)) {
            const issueList = issues.map(i => `• ${i.category}(${i.severity}): ${i.title}`).join('\n');
            const message = `【OP周督办 - ${store}】\n\n门店本周有以下异常需整改：\n\n${issueList}\n\n请在今日内提交整改方案。`;
            
            // 发送给店长/出品经理
            for (const issue of issues) {
              try {
                await pushIssueToAssignee(issue, message);
              } catch (e) {
                console.error(`[scheduler] OP周督办推送失败: ${issue.assignee_username}`, e?.message);
              }
            }
          }
        } else {
          console.log('[scheduler] OP Agent: 本周无周异常需督办');
        }
      }
    } catch (e) {
      console.error('[scheduler] OP周督办 tick error:', e?.message);
    }
  };

  // OP Agent: 每天早上10点督办充值异常
  const dailyRechargeTick = async () => {
    try {
      const now = new Date();
      // 每天10点执行（分钟数<5避免重复执行）
      if (now.getHours() === 10 && now.getMinutes() < 5) {
        console.log('[scheduler] OP Agent: 开始督办充值异常...');
        
        // 查询过去24小时的充值异常（未解决的）
        const result = await pool().query(
          `SELECT * FROM agent_issues 
           WHERE category = '充值异常'
             AND status != 'resolved'
             AND created_at >= NOW() - INTERVAL '24 hours'
           ORDER BY store`
        );
        
        if (result.rows?.length > 0) {
          console.log(`[scheduler] OP Agent: 发现 ${result.rows.length} 条充值异常待督办`);
          
          // 按门店分组
          const byStore = {};
          for (const issue of result.rows) {
            if (!byStore[issue.store]) byStore[issue.store] = [];
            byStore[issue.store].push(issue);
          }
          
          for (const [store, issues] of Object.entries(byStore)) {
            const highCount = issues.filter(i => i.severity === 'high').length;
            const mediumCount = issues.filter(i => i.severity === 'medium').length;
            const message = `【OP日督办 - ${store}】\n\n门店今日充值异常：\n• 高风险: ${highCount} 条\n• 中风险: ${mediumCount} 条\n\n请立即检查充值系统并提交整改方案。`;
            
            // 发送给店长
            for (const issue of issues) {
              try {
                await pushIssueToAssignee(issue, message);
              } catch (e) {
                console.error(`[scheduler] OP日督办推送失败: ${issue.assignee_username}`, e?.message);
              }
            }
          }
        } else {
          console.log('[scheduler] OP Agent: 今日无充值异常需督办');
        }
      }
    } catch (e) {
      console.error('[scheduler] OP日督办 tick error:', e?.message);
    }
  };

  // Retry pushing un-notified items every 5 minutes
  const pushTick = async () => {
    try {
      const pushedIssues = await pushIssuesToFeishu();
      const pushedScores = await pushScoresToFeishu();
      if (pushedIssues || pushedScores) {
        console.log(`[scheduler] Push retry: ${pushedIssues} issues, ${pushedScores} scores`);
      }
    } catch (e) {}
  };

  // Initial run after 15 seconds
  setTimeout(auditTick, 15000);

  // Periodic runs
  setInterval(auditTick, 30 * 60 * 1000);   // every 30 min
  setInterval(evalTick, 60 * 60 * 1000);     // every hour
  setInterval(weeklyOpsTick, 60 * 60 * 1000); // every hour (checks if Monday 10am)
  setInterval(dailyRechargeTick, 60 * 60 * 1000); // every hour (checks if 10am)
  setInterval(pushTick, 5 * 60 * 1000);      // every 5 min

  console.log('[agents] Feishu-first multi-agent scheduler started (with OP daily/weekly supervision)');
}

// ─────────────────────────────────────────────
// 15. Performance Monitoring API
// ─────────────────────────────────────────────

export function getAgentPerformanceMetrics() {
  return {
    ..._performanceMetrics,
    cacheHitRate: _performanceMetrics.totalCalls > 0 ? 
      (_performanceMetrics.cacheHits / _performanceMetrics.totalCalls * 100).toFixed(2) + '%' : '0%',
    contextSize: _conversationContext.size,
    cacheSize: _responseCache.size,
    uptime: process.uptime()
  };
}

export function clearAgentCache() {
  _responseCache.clear();
  _conversationContext.clear();
  console.log('[agents] Cache cleared');
}

// 定期清理过期缓存
setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  
  for (const [key, value] of _responseCache.entries()) {
    if (now - value.timestamp > CACHE_TTL) {
      _responseCache.delete(key);
      cleaned++;
    }
  }
  
  if (cleaned > 0) {
    console.log(`[agents] Cleaned ${cleaned} expired cache entries`);
  }
}, 10 * 60 * 1000); // 每10分钟清理一次

export function registerAgentRoutes(app, authRequired) {

  // ── Feishu Webhook (public, no auth) ──
  app.post('/api/feishu/webhook', async (req, res) => {
    try {
      const result = await onFeishuEvent(req.body);
      return res.json(result);
    } catch (e) {
      console.error('[feishu webhook] error:', e?.message);
      return res.status(200).json({ ok: true, error: String(e?.message || e) });
    }
  });

  // ── Admin: Agent Dashboard summary ──
  app.get('/api/agents/dashboard', authRequired, async (req, res) => {
    const role = String(req.user?.role || '').trim();
    if (!['admin', 'hq_manager', 'hr_manager'].includes(role)) return res.status(403).json({ error: 'forbidden' });
    try {
      const [issuesR, scoresR, auditsR, messagesR, usersR] = await Promise.all([
        pool().query(`SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE status='open') as open, COUNT(*) FILTER (WHERE severity='high' AND status='open') as high_open FROM agent_issues`),
        pool().query(`SELECT COUNT(*) as total, ROUND(AVG(total_score)::numeric, 1) as avg_score FROM agent_scores WHERE created_at > NOW() - INTERVAL '30 days'`),
        pool().query(`SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE result='fail') as failed, COUNT(*) FILTER (WHERE duplicate_of IS NOT NULL) as duplicates FROM agent_visual_audits WHERE created_at > NOW() - INTERVAL '30 days'`),
        pool().query(`SELECT COUNT(*) as total FROM agent_messages WHERE created_at > NOW() - INTERVAL '7 days'`),
        pool().query(`SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE registered=TRUE) as registered FROM feishu_users`)
      ]);
      return res.json({
        issues: issuesR.rows[0],
        scores: scoresR.rows[0],
        audits: auditsR.rows[0],
        messages: { total_7d: messagesR.rows[0]?.total },
        feishuUsers: usersR.rows[0],
        performance: getAgentPerformanceMetrics()
      });
    } catch (e) {
      return res.status(500).json({ error: String(e?.message || e) });
    }
  });

  // ── Performance Monitoring API ──
  app.get('/api/agents/performance', authRequired, async (req, res) => {
    const role = String(req.user?.role || '').trim();
    if (!['admin', 'hq_manager'].includes(role)) return res.status(403).json({ error: 'forbidden' });
    try {
      return res.json(getAgentPerformanceMetrics());
    } catch (e) {
      return res.status(500).json({ error: String(e?.message || e) });
    }
  });

  // ── Clear Cache API ──
  app.post('/api/agents/clear-cache', authRequired, async (req, res) => {
    const role = String(req.user?.role || '').trim();
    if (!['admin', 'hq_manager'].includes(role)) return res.status(403).json({ error: 'forbidden' });
    try {
      clearAgentCache();
      return res.json({ ok: true, message: 'Cache cleared successfully' });
    } catch (e) {
      return res.status(500).json({ error: String(e?.message || e) });
    }
  });

  // ── Issues list ──
  app.get('/api/agents/issues', authRequired, async (req, res) => {
    const username = String(req.user?.username || '').trim();
    const role = String(req.user?.role || '').trim();
    const status = String(req.query?.status || '').trim();
    const limit = Math.max(1, Math.min(200, Number(req.query?.limit) || 50));
    try {
      let where = ['1=1'], params = [];
      const push = v => { params.push(v); return `$${params.length}`; };
      if (role === 'store_manager' || role === 'store_production_manager') where.push(`assignee_username = ${push(username)}`);
      if (status && status !== 'all') where.push(`status = ${push(status)}`);
      const r = await pool().query(`SELECT * FROM agent_issues WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ${push(limit)}`, params);
      return res.json({ items: r.rows || [] });
    } catch (e) { return res.status(500).json({ error: String(e?.message || e) }); }
  });

  // ── Resolve issue ──
  app.post('/api/agents/issues/:id/resolve', authRequired, async (req, res) => {
    const id = String(req.params?.id || '').trim();
    const resolution = String(req.body?.resolution || '').trim();
    if (!id) return res.status(400).json({ error: 'missing_id' });
    try {
      await pool().query(`UPDATE agent_issues SET status='resolved', resolution=$1, resolved_at=NOW(), updated_at=NOW() WHERE id=$2`, [resolution, id]);
      return res.json({ ok: true });
    } catch (e) { return res.status(500).json({ error: String(e?.message || e) }); }
  });

  // ── My Score (for profile page) ──
  app.get('/api/agent-scores/me', authRequired, async (req, res) => {
    const username = String(req.user?.username || '').trim();
    if (!username) return res.status(400).json({ error: 'missing_username' });
    try {
      const r = await pool().query(
        `SELECT total_score, breakdown, summary, period, brand, store FROM agent_scores WHERE username = $1 ORDER BY created_at DESC LIMIT 1`,
        [username]
      );
      if (!r.rows?.length) return res.json({ total_score: null, breakdown: {} });
      const row = r.rows[0];
      return res.json({ total_score: row.total_score, breakdown: row.breakdown || {}, summary: row.summary, period: row.period, brand: row.brand, store: row.store });
    } catch (e) { return res.status(500).json({ error: String(e?.message || e) }); }
  });

  // ── Scores ──
  app.get('/api/agents/scores', authRequired, async (req, res) => {
    const username = String(req.user?.username || '').trim();
    const role = String(req.user?.role || '').trim();
    const limit = Math.max(1, Math.min(100, Number(req.query?.limit) || 20));
    try {
      let where = ['1=1'], params = [];
      const push = v => { params.push(v); return `$${params.length}`; };
      if (role === 'store_manager' || role === 'store_production_manager') where.push(`username = ${push(username)}`);
      const r = await pool().query(`SELECT * FROM agent_scores WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ${push(limit)}`, params);
      return res.json({ items: r.rows || [] });
    } catch (e) { return res.status(500).json({ error: String(e?.message || e) }); }
  });

  // ── Visual audits ──
  app.get('/api/agents/audits', authRequired, async (req, res) => {
    const username = String(req.user?.username || '').trim();
    const role = String(req.user?.role || '').trim();
    const limit = Math.max(1, Math.min(200, Number(req.query?.limit) || 50));
    try {
      let where = ['1=1'], params = [];
      const push = v => { params.push(v); return `$${params.length}`; };
      if (role === 'store_manager' || role === 'store_production_manager') where.push(`username = ${push(username)}`);
      const r = await pool().query(`SELECT * FROM agent_visual_audits WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ${push(limit)}`, params);
      return res.json({ items: r.rows || [] });
    } catch (e) { return res.status(500).json({ error: String(e?.message || e) }); }
  });

  // ── Appeals ──
  app.post('/api/agents/appeals', authRequired, async (req, res) => {
    const username = String(req.user?.username || '').trim();
    const reason = String(req.body?.reason || '').trim();
    if (!username || !reason) return res.status(400).json({ error: 'missing_params' });
    try {
      const r = await pool().query(`INSERT INTO agent_appeals (username, reason) VALUES ($1,$2) RETURNING id`, [username, reason]);
      return res.json({ ok: true, id: r.rows?.[0]?.id });
    } catch (e) { return res.status(500).json({ error: String(e?.message || e) }); }
  });

  app.get('/api/agents/appeals', authRequired, async (req, res) => {
    const username = String(req.user?.username || '').trim();
    const role = String(req.user?.role || '').trim();
    const limit = Math.max(1, Math.min(100, Number(req.query?.limit) || 20));
    try {
      let where = ['1=1'], params = [];
      const push = v => { params.push(v); return `$${params.length}`; };
      if (role === 'store_manager' || role === 'store_production_manager') where.push(`username = ${push(username)}`);
      const r = await pool().query(`SELECT * FROM agent_appeals WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ${push(limit)}`, params);
      return res.json({ items: r.rows || [] });
    } catch (e) { return res.status(500).json({ error: String(e?.message || e) }); }
  });

  // ── Message log (admin) ──
  app.get('/api/agents/messages', authRequired, async (req, res) => {
    const role = String(req.user?.role || '').trim();
    const limit = Math.max(1, Math.min(200, Number(req.query?.limit) || 50));
    try {
      let where = ['1=1'], params = [];
      const push = v => { params.push(v); return `$${params.length}`; };
      if (!['admin', 'hq_manager', 'hr_manager'].includes(role)) {
        where.push(`sender_username = ${push(req.user?.username || '')}`);
      }
      const r = await pool().query(
        `SELECT id, direction, channel, sender_username, sender_name, routed_to, content_type, content, agent_response, created_at
         FROM agent_messages WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ${push(limit)}`, params);
      return res.json({ items: r.rows || [] });
    } catch (e) { return res.status(500).json({ error: String(e?.message || e) }); }
  });

  // ── Feishu user management (admin) ──
  app.get('/api/agents/feishu-users', authRequired, async (req, res) => {
    const role = String(req.user?.role || '').trim();
    if (!['admin', 'hq_manager', 'hr_manager'].includes(role)) return res.status(403).json({ error: 'forbidden' });
    try {
      const r = await pool().query(`SELECT * FROM feishu_users ORDER BY created_at DESC LIMIT 100`);
      return res.json({ items: r.rows || [] });
    } catch (e) { return res.status(500).json({ error: String(e?.message || e) }); }
  });

  // Admin manually bind feishu user
  app.post('/api/agents/feishu-users/bind', authRequired, async (req, res) => {
    const role = String(req.user?.role || '').trim();
    if (!['admin', 'hq_manager', 'hr_manager'].includes(role)) return res.status(403).json({ error: 'forbidden' });
    const openId = String(req.body?.openId || '').trim();
    const username = String(req.body?.username || '').trim();
    if (!openId || !username) return res.status(400).json({ error: 'missing_params' });
    try {
      const result = await registerFeishuUser(openId, username);
      return res.json(result);
    } catch (e) { return res.status(500).json({ error: String(e?.message || e) }); }
  });

  // ── Manual triggers (admin) ──
  app.post('/api/agents/run/audit', authRequired, async (req, res) => {
    const role = String(req.user?.role || '').trim();
    if (role !== 'admin' && role !== 'hq_manager') return res.status(403).json({ error: 'forbidden' });
    try {
      const result = await runDataAuditor();
      const pushed = await pushIssuesToFeishu();
      return res.json({ ...result, feishuPushed: pushed });
    } catch (e) { return res.status(500).json({ error: String(e?.message || e) }); }
  });

  app.post('/api/agents/run/evaluate', authRequired, async (req, res) => {
    const role = String(req.user?.role || '').trim();
    if (role !== 'admin' && role !== 'hq_manager') return res.status(403).json({ error: 'forbidden' });
    const period = String(req.body?.period || '').trim();
    if (!period) return res.status(400).json({ error: 'missing_period' });
    try {
      const result = await runChiefEvaluator(period);
      const pushed = await pushScoresToFeishu();
      return res.json({ ...result, feishuPushed: pushed });
    } catch (e) { return res.status(500).json({ error: String(e?.message || e) }); }
  });

  // ── Send test message to Feishu (admin) ── H2-FIX: 修复断裂的路由处理器
  app.post('/api/agents/test-feishu', authRequired, async (req, res) => {
    const role = String(req.user?.role || '').trim();
    if (role !== 'admin') return res.status(403).json({ error: 'forbidden' });
    const openId = String(req.body?.openId || '').trim();
    const text = String(req.body?.text || 'HRMS Agent 测试消息').trim();
    if (!openId) return res.status(400).json({ error: 'missing_openId' });
    try {
      const result = await sendLarkMessage(openId, text);
      return res.json(result);
    } catch (e) { return res.status(500).json({ error: String(e?.message || e) }); }
  });

  // ── Vision LLM Test (admin) ──
  app.post('/api/agents/test-vision', authRequired, async (req, res) => {
    const role = String(req.user?.role || '').trim();
    if (role !== 'admin') return res.status(403).json({ error: 'forbidden' });
    const imageUrl = String(req.body?.imageUrl || '').trim();
    const prompt = String(req.body?.prompt || '请识别这张图片中的内容，判断是否为餐厅厨房环境或整改照片').trim();
    if (!imageUrl) return res.status(400).json({ error: 'missing_imageUrl' });
    try {
      const result = await callVisionLLM(imageUrl, prompt);
      return res.json({ ok: result.ok, content: result.content, error: result.error || null });
    } catch (e) { return res.status(500).json({ error: String(e?.message || e) }); }
  });

  // ── LLM Test (admin) ──
  app.post('/api/agents/test-llm', authRequired, async (req, res) => {
    const role = String(req.user?.role || '').trim();
    if (role !== 'admin') return res.status(403).json({ error: 'forbidden' });
    const prompt = String(req.body?.prompt || '请用一句话介绍潮汕菜的特点').trim();
    try {
      const result = await callLLM(prompt);
      return res.json({ ok: result.ok, content: result.content, error: result.error || null });
    } catch (e) { return res.status(500).json({ error: String(e?.message || e) }); }
  });

  // ── Test endpoints (admin only) ──

  // Test: get feishu tenant token
  app.get('/api/agents/feishu-token-test', authRequired, async (req, res) => {
    const role = String(req.user?.role || '').trim();
    if (!['admin', 'hq_manager'].includes(role)) return res.status(403).json({ error: 'forbidden' });
    try {
      const token = await getLarkTenantToken();
      if (!token) return res.json({ ok: false, error: 'no_token — check LARK_APP_ID / LARK_APP_SECRET in .env' });
      return res.json({ ok: true, token: token.slice(0, 8) + '...' + token.slice(-4), length: token.length });
    } catch (e) { return res.status(500).json({ ok: false, error: String(e?.message || e) }); }
  });

  // Test: send arbitrary message to a feishu open_id
  app.post('/api/agents/feishu-send-test', authRequired, async (req, res) => {
    const role = String(req.user?.role || '').trim();
    if (!['admin', 'hq_manager'].includes(role)) return res.status(403).json({ error: 'forbidden' });
    const openId = String(req.body?.openId || '').trim();
    const message = String(req.body?.message || 'HRMS Agent 测试消息').trim();
    if (!openId) return res.status(400).json({ error: 'missing openId' });
    try {
      const result = await sendLarkMessage(openId, message);
      return res.json(result);
    } catch (e) { return res.status(500).json({ ok: false, error: String(e?.message || e) }); }
  });

  // Test: message routing logic (no side effects)
  app.post('/api/agents/route-test', authRequired, async (req, res) => {
    const text = String(req.body?.text || '').trim();
    const hasImage = !!req.body?.hasImage;
    const route = routeMessage(text, hasImage);
    const AUDIT_KEYWORDS = ['损耗', '盘点', '毛利', '牛肉', '成本', '差评', '折扣', '营收', '对账', '异常'];
    const OPS_KEYWORDS = ['图片', '卫生', '检查', '拍照', '摆盘', '收货', '消毒', '开市', '闭市', '巡检'];
    const EVAL_KEYWORDS = ['分数', '绩效', '考核', '奖金', '得分', '扣分', '排名', '评价', '这周'];
    const HR_KEYWORDS = ['离职', '辞职', '入职', '转正', '晋升', '调岗', '加薪', '薪资', '工资', '请假', '休假', '社保', '人事', '档案', '考勤'];
    const APPEAL_KEYWORDS = ['申诉', '取消扣分', '不公平', '误判', '恢复', '投诉', '举报'];
    const SOP_KEYWORDS = ['SOP', '赔付', '退款', '培训', '入职培训', '课件', '带教', '讲师', '考核培训', '技能培训', '标准作业'];
    const matched = [
      ...AUDIT_KEYWORDS.filter(k => text.includes(k)).map(k => `audit:${k}`),
      ...OPS_KEYWORDS.filter(k => text.includes(k)).map(k => `ops:${k}`),
      ...HR_KEYWORDS.filter(k => text.includes(k)).map(k => `hr:${k}`),
      ...EVAL_KEYWORDS.filter(k => text.includes(k)).map(k => `eval:${k}`),
      ...APPEAL_KEYWORDS.filter(k => text.includes(k)).map(k => `appeal:${k}`),
      ...SOP_KEYWORDS.filter(k => text.includes(k)).map(k => `train:${k}`),
    ];
    return res.json({ route, text, hasImage, matchedKeywords: matched });
  });
}

// ─────────────────────────────────────────────
// 辅助函数 - 数据源质量检查
// ─────────────────────────────────────────────

// Data Auditor 数据源质量检查
async function checkDataSourceQuality() {
  return safeExecute('data_auditor_quality_check', async () => {
    const issues = [];
    
    // 检查 Bitable 数据同步状态
    try {
      for (const [configKey, config] of Object.entries(BITABLE_CONFIGS)) {
        const lastSync = await getLastSyncTime(configKey);
        const syncAge = Date.now() - lastSync;
        
        // 如果超过10分钟没有同步，报告问题
        if (syncAge > 10 * 60 * 1000) {
          await safeExecute('data_source_issue_report', async () => {
            await AgentCommunicationHelper.reportDataSourceIssue(
              configKey,
              `Bitable ${config.name} 数据同步超时`,
              `最后同步时间: ${new Date(lastSync).toLocaleString()}`,
              '建议检查网络连接和API配置'
            );
          });
          issues.push(configKey);
        }
      }
    } catch (error) {
      safeErrorLog('data_auditor_bitable_sync', error);
    }
    
    // 检查数据完整性
    try {
      const state = await getSharedState();
      const reportCount = Array.isArray(state?.dailyReports) ? state.dailyReports.length : 0;
      
      if (reportCount < 100) {
        await safeExecute('data_completeness_report', async () => {
          await AgentCommunicationHelper.reportDataSourceIssue(
            'daily_reports',
            `营业数据量不足: ${reportCount} 条记录`,
            '可能影响异常检测准确性',
            '建议检查数据采集机制'
          );
        });
        issues.push('daily_reports');
      }
    } catch (error) {
      safeErrorLog('data_auditor_completeness', error);
    }
    
    return issues;
  }, []);
}

async function getLastSyncTime(configKey) {
  // 这里可以实现实际的同步时间检查逻辑
  // 暂时返回当前时间减去随机延迟
  return Date.now() - Math.random() * 5 * 60 * 1000;
}

// Ops Agent 任务执行质量检查
async function checkTaskExecutionQuality(storeName, brand, failedCount, duplicateCount) {
  return safeExecute('ops_agent_quality_check', async () => {
    // 如果失败率过高，报告问题
    const totalAudits = await getRecentAuditCount(storeName, 7); // 最近7天
    const failureRate = totalAudits > 0 ? failedCount / totalAudits : 0;
    
    if (failureRate > 0.15) { // 失败率超过15%
      await safeExecute('task_execution_issue_report', async () => {
        await AgentCommunicationHelper.reportTaskExecutionIssue(
          '图片审核',
          `图片审核失败率过高: ${(failureRate * 100).toFixed(1)}%`,
          failureRate,
          '建议优化审核算法或增加人工复核'
        );
      });
    }
    
    // 如果重复图片过多，报告问题
    const duplicateRate = totalAudits > 0 ? duplicateCount / totalAudits : 0;
    if (duplicateRate > 0.10) { // 重复率超过10%
      await safeExecute('duplicate_image_issue_report', async () => {
        await AgentCommunicationHelper.reportTaskExecutionIssue(
          '图片审核',
          `重复图片率过高: ${(duplicateRate * 100).toFixed(1)}%`,
          duplicateRate,
          '建议加强反作弊机制和用户教育'
        );
      });
    }
  });
}

async function getRecentAuditCount(storeName, days) {
  try {
    const result = await pool().query(`
      SELECT COUNT(*) as count 
      FROM agent_visual_audits 
      WHERE store = $1 
        AND created_at >= NOW() - make_interval(days => $2)
    `, [storeName, Math.max(1, Math.floor(Number(days) || 7))]);
    
    return Number(result.rows[0]?.count || 0);
  } catch (error) {
    console.error('[ops_agent] Failed to get audit count:', error);
    return 0;
  }
}
