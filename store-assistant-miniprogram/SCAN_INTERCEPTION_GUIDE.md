# 扫码拦截与客如云跳转 - 完整实现指南

## 📋 方案概述

**核心流程**: 客户扫描桌贴二维码 → 进入『年年有喜』小程序 → 强制手机号授权 → 检测老会员 → 跳转客如云点餐

---

## 🎯 已实现功能

### 1️⃣ **扫码参数解析** (`app.js`)

```javascript
// 支持场景值
- 1047: 扫描小程序码
- 1011: 扫描二维码

// 解析参数
- table_id: 桌号
- store_id: 门店ID
- timestamp: 扫码时间
```

### 2️⃣ **强制授权弹窗** (`index.wxml` + `index.wxss`)

**视觉特性**:
- ✅ 高级橙色渐变背景 (`#FFFFFF → #FFF8F0`)
- ✅ 毛玻璃模糊遮罩 (`backdrop-filter: blur(10rpx)`)
- ✅ 动态图标动画 (上下浮动)
- ✅ 三大权益展示 (新人礼包/积分返现/专属优惠)
- ✅ 渐变按钮 + 阴影效果

**交互逻辑**:
- 扫码进入 → 检查手机号 → 未授权显示弹窗
- 已授权 → 直接跳转客如云

### 3️⃣ **老会员检测动效** (`index.wxml` + `index.wxss`)

**视觉特性**:
- ✅ 全屏橙色渐变背景 (`#FF6A00 → #FF8E3C`)
- ✅ 旋转星星图标 (360° 无限旋转)
- ✅ 积分数字缩放动画
- ✅ 加载点跳动效果
- ✅ 1.5秒后自动跳转

### 4️⃣ **手机号保存云函数** (`saveUserPhone`)

**核心功能**:
```javascript
1. 调用微信接口解密手机号
2. 查询 LegacyMembers 集合检测老会员
3. 同步老会员数据 (积分/消费/等级)
4. 保存用户信息到 Users 集合
5. 记录扫码日志到 ScanLogs 集合
6. 标记老会员已同步
```

### 5️⃣ **客如云跳转逻辑** (`index.js`)

```javascript
wx.navigateToMiniProgram({
  appId: 'wx1234567890abcdef', // 客如云 AppID
  path: 'pages/order/index?table_id=xxx&store_id=xxx',
  extraData: {
    from: 'niannianyouxi',
    table_id: table_id,
    store_id: store_id
  }
});
```

---

## 📊 数据库设计

### 新增集合

#### **LegacyMembers** (老会员数据)
```json
{
  "_id": "auto",
  "phone": "13800138000",
  "points": 1200,
  "total_spent": 50000,
  "member_level": "金卡",
  "is_synced": false,
  "synced_at": null,
  "created_at": "serverDate()",
  "source": "keruyun_import"
}
```

#### **ScanLogs** (扫码日志)
```json
{
  "_id": "auto",
  "_openid": "oXXXX...",
  "phone": "13800138000",
  "table_id": "T01",
  "store_id": "hongchao_daning",
  "is_legacy_member": true,
  "legacy_points": 1200,
  "created_at": "serverDate()"
}
```

#### **Users** 集合扩展字段
```json
{
  "phone": "13800138000",
  "is_legacy_member": true,
  "legacy_points": 1200,
  "legacy_synced_at": "serverDate()",
  "last_scan": {
    "table_id": "T01",
    "store_id": "hongchao_daning",
    "timestamp": 1708588800000
  }
}
```

---

## 🚀 部署步骤

### 步骤 1: 配置客如云小程序信息

修改 `app.js`:
```javascript
keruYunConfig: {
  appId: 'wx1234567890abcdef', // 替换为客如云真实 AppID
  path: 'pages/order/index'     // 替换为客如云点餐页面路径
}
```

### 步骤 2: 上传云函数

```bash
# 安装依赖
cd cloudfunctions/saveUserPhone
npm install

# 在微信开发者工具中上传
右键 saveUserPhone → 上传并部署: 云端安装依赖
```

### 步骤 3: 配置小程序跳转白名单

在微信公众平台:
1. 设置 → 第三方设置 → 小程序跳转
2. 添加客如云小程序 AppID 到白名单

### 步骤 4: 导入老会员数据

在云开发控制台 → 数据库 → LegacyMembers:

```javascript
// 批量导入示例
[
  {
    "phone": "13800138000",
    "points": 1200,
    "total_spent": 50000,
    "member_level": "金卡",
    "is_synced": false,
    "source": "keruyun_import"
  },
  {
    "phone": "13900139000",
    "points": 800,
    "total_spent": 30000,
    "member_level": "银卡",
    "is_synced": false,
    "source": "keruyun_import"
  }
]
```

### 步骤 5: 生成桌贴二维码

使用微信开发者工具 → 工具 → 生成小程序码:

**参数配置**:
```
页面路径: pages/index/index
场景值: table_id=T01&store_id=hongchao_daning
```

---

## 🧪 测试流程

### 测试 1: 新用户扫码流程

1. **扫描桌贴二维码**
2. **预期**: 进入小程序，显示强制授权弹窗
3. **点击授权按钮**
4. **预期**: 
   - 显示 "正在入会..." 加载提示
   - 授权成功后弹窗消失
   - 直接跳转到客如云点餐页面
5. **验证数据库**:
   - `Users` 集合新增记录，包含手机号
   - `ScanLogs` 集合新增扫码日志
   - `is_legacy_member` = false

---

### 测试 2: 老会员扫码流程

1. **准备**: 在 `LegacyMembers` 添加测试数据
   ```json
   {
     "phone": "13800138000",
     "points": 1200,
     "is_synced": false
   }
   ```

2. **扫描桌贴二维码**
3. **授权手机号** (使用 13800138000)
4. **预期**:
   - 显示老会员检测动效
   - 显示 "检测到老会员"
   - 显示 "积分已同步 +1200"
   - 1.5秒后自动跳转客如云

5. **验证数据库**:
   - `Users` 集合: `is_legacy_member` = true, `legacy_points` = 1200
   - `LegacyMembers` 集合: `is_synced` = true
   - `ScanLogs` 集合: `is_legacy_member` = true

---

### 测试 3: 已授权用户再次扫码

1. **使用已授权的账号扫码**
2. **预期**: 
   - 不显示授权弹窗
   - 直接跳转客如云
3. **验证**: `Users.last_scan` 字段更新为最新扫码信息

---

## 🔧 关键代码说明

### 扫码参数解析 (`app.js`)

```javascript
parseLaunchOptions(options) {
  const { scene, query } = options;
  
  // 场景值: 1047 扫描小程序码, 1011 扫描二维码
  if (scene === 1047 || scene === 1011) {
    if (query && (query.table_id || query.store_id)) {
      this.globalData.scanParams = {
        table_id: query.table_id || '',
        store_id: query.store_id || '',
        scene: scene,
        timestamp: Date.now()
      };
    }
  }
}
```

### 授权检查逻辑 (`index.js`)

```javascript
async checkPhoneAuthorization() {
  const res = await db.collection('Users')
    .where({ _openid: '{openid}' })
    .get();

  if (res.data.length > 0 && res.data[0].phone) {
    // 已授权，直接跳转
    this.navigateToKeruYun();
  } else {
    // 未授权，显示弹窗
    this.setData({ showAuthModal: true });
  }
}
```

### 老会员检测 (`saveUserPhone/index.js`)

```javascript
async function checkLegacyMember(phone) {
  const res = await db.collection('LegacyMembers')
    .where({
      phone: phone,
      is_synced: false
    })
    .get();

  if (res.data.length > 0) {
    return {
      isLegacy: true,
      points: res.data[0].points || 0,
      legacy_id: res.data[0]._id
    };
  }

  return { isLegacy: false, points: 0 };
}
```

---

## 📱 UI 效果预览

### 强制授权弹窗
```
┌─────────────────────────────┐
│          🎊                 │
│      禧事临门！              │
│  请先授权手机号领取会员权益   │
│                             │
│  🎁        💰        🎉     │
│ 新人礼包  积分返现  专属优惠  │
│                             │
│  ┌───────────────────────┐  │
│  │   立即授权领取        │  │
│  └───────────────────────┘  │
│   授权后即可进入点餐页面     │
└─────────────────────────────┘
```

### 老会员检测动效
```
┌─────────────────────────────┐
│          ✨                 │
│     检测到老会员             │
│                             │
│      积分已同步              │
│        +1200                │
│                             │
│       ● ● ●                 │
└─────────────────────────────┘
```

---

## 🔐 安全要点

| 安全措施 | 实现方式 |
|---------|---------|
| **手机号加密** | 使用微信官方接口解密，不在前端明文传输 |
| **防重复授权** | 检查 `Users.phone` 字段，已授权直接跳转 |
| **老会员去重** | `is_synced` 标记防止重复同步积分 |
| **扫码日志** | 记录所有扫码行为，便于追溯 |
| **参数校验** | 云函数严格校验 `code` 参数 |

---

## 📊 数据流转图

```
扫码进入
  ↓
app.js 解析参数 (table_id, store_id)
  ↓
index.js 检查授权状态
  ↓
未授权 → 显示授权弹窗
  ↓
用户点击授权
  ↓
调用 saveUserPhone 云函数
  ↓
解密手机号
  ↓
检测 LegacyMembers 集合
  ↓
是老会员? 
  ├─ 是 → 显示动效 (1.5s) → 同步数据
  └─ 否 → 直接保存
  ↓
跳转客如云小程序
  ↓
携带参数: table_id, store_id
```

---

## 🎯 下一步优化建议

1. **订阅消息通知**: 授权成功后发送欢迎消息
2. **积分规则配置**: 支持不同门店的积分倍率
3. **会员等级升级**: 根据消费自动升级会员等级
4. **扫码统计分析**: 统计各桌台扫码转化率
5. **异常处理优化**: 客如云跳转失败时的降级方案

---

## 📞 常见问题

### Q1: 授权后跳转失败？
**A**: 检查客如云 AppID 是否在小程序跳转白名单中

### Q2: 老会员检测不到？
**A**: 确认 `LegacyMembers` 集合中手机号格式一致 (无空格/特殊字符)

### Q3: 扫码参数获取不到？
**A**: 确认小程序码生成时场景值格式正确: `table_id=T01&store_id=xxx`

### Q4: 授权弹窗不显示？
**A**: 检查 `app.globalData.scanParams` 是否正确解析

---

**版本**: v1.0.0  
**更新时间**: 2026-02-22  
**状态**: ✅ 已完成
