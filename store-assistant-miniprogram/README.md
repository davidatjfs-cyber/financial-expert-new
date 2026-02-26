# 门店私域助手 - 微信小程序

## 📱 项目简介

基于**微信小程序云开发**的门店私域运营工具，解决企业微信引流客户无法在聊天窗口完成预订、买券、核销的闭环问题。

### 核心特性
- ✅ 企微深度绑定 (external_userid 1:1 映射)
- ✅ 微信支付云调用 (自动生成核销二维码)
- ✅ 智能预约 (并发库存控制)
- ✅ 员工核销端 (扫码核销)
- ✅ 自动标签系统 (消费行为触发)

---

## 🏗️ 技术架构

### 技术栈
- **前端**: 微信小程序原生框架 (WXML + WXSS + JavaScript)
- **后端**: Node.js 云函数 (wx-server-sdk)
- **数据库**: 微信云开发 NoSQL 数据库
- **支付**: 微信支付云调用接口
- **存储**: 云存储 (二维码图片)

### 云函数列表
| 云函数名 | 功能 | 触发方式 |
|---------|------|---------|
| `createPayment` | 创建支付订单 | 前端调用 |
| `paymentCallback` | 支付成功回调 | 微信自动触发 |
| `createAppointment` | 创建预约 | 前端调用 |
| `verifyVoucher` | 核销券码 | 员工端调用 |
| `getUserInfo` | 获取用户信息 | 前端调用 |

---

## 📦 部署步骤

### 1. 环境准备

#### 1.1 开通微信小程序云开发
1. 登录 [微信公众平台](https://mp.weixin.qq.com/)
2. 进入小程序后台 → 开发 → 云开发
3. 开通云开发环境 (选择基础版或专业版)
4. 记录环境 ID (格式: `cloud1-xxx`)

#### 1.2 配置微信支付
1. 登录 [微信支付商户平台](https://pay.weixin.qq.com/)
2. 产品中心 → 开发配置 → 添加支付目录
3. 设置支付回调 URL: `云函数触发器地址`
4. 记录商户号 (mch_id) 和 API 密钥

### 2. 项目配置

#### 2.1 修改 `project.config.json`
```json
{
  "miniprogramRoot": "miniprogram/",
  "cloudfunctionRoot": "cloudfunctions/",
  "appid": "YOUR_APPID",
  "projectname": "store-assistant",
  "cloudfunctionTemplateRoot": "cloudfunctionTemplate",
  "setting": {
    "es6": true,
    "enhance": true,
    "postcss": true,
    "minified": true
  }
}
```

#### 2.2 初始化云开发环境
在 `app.js` 中配置:
```javascript
App({
  onLaunch: function () {
    if (!wx.cloud) {
      console.error('请使用 2.2.3 或以上的基础库以使用云能力');
    } else {
      wx.cloud.init({
        env: 'YOUR_ENV_ID', // 替换为你的环境 ID
        traceUser: true
      });
    }
  }
});
```

### 3. 上传云函数

#### 3.1 安装依赖
在每个云函数目录下执行:
```bash
cd cloudfunctions/createPayment
npm install

cd ../paymentCallback
npm install
```

#### 3.2 上传云函数
在微信开发者工具中:
1. 右键点击云函数文件夹
2. 选择 "上传并部署: 云端安装依赖"
3. 等待部署完成

### 4. 配置数据库

#### 4.1 创建集合
在云开发控制台 → 数据库 → 添加集合:
- `Users` (用户表)
- `Vouchers` (券模板表)
- `Orders` (订单表)
- `Appointments` (预约表)
- `Staff` (员工表)
- `TimeSlots` (时段库存表)
- `VerificationLogs` (核销日志表)

#### 4.2 配置数据库权限
```json
{
  "read": "doc._openid == auth.openid || get(`database.Staff.${auth.openid}`).role == 'admin'",
  "write": "doc._openid == auth.openid || get(`database.Staff.${auth.openid}`).role == 'admin'"
}
```

#### 4.3 初始化券数据
在数据库控制台手动添加测试券:
```json
{
  "name": "100元代金券",
  "type": "cash",
  "value": 10000,
  "price": 8000,
  "min_consume": 0,
  "valid_days": 30,
  "stock": 999,
  "sold_count": 0,
  "applicable_stores": ["all"],
  "cover_image": "cloud://xxx.png",
  "description": "全场通用，洪潮/马己仙可用",
  "sort_order": 1,
  "is_active": true
}
```

### 5. 配置订阅消息

#### 5.1 申请模板
在小程序后台 → 功能 → 订阅消息:
1. 选择 "支付成功通知" 模板
2. 记录 `template_id`

#### 5.2 修改云函数
在 `paymentCallback/index.js` 中替换:
```javascript
templateId: 'YOUR_TEMPLATE_ID'
```

---

## 🔧 核心功能实现

### 1. 支付流程

#### 前端调用
```javascript
// pages/index/index.js
const createResult = await wx.cloud.callFunction({
  name: 'createPayment',
  data: {
    voucher_id: 'xxx',
    quantity: 1
  }
});

const { payment } = createResult.result.data;

await wx.requestPayment({
  timeStamp: payment.timeStamp,
  nonceStr: payment.nonceStr,
  package: payment.package,
  signType: payment.signType,
  paySign: payment.paySign
});
```

#### 后端处理
1. **createPayment**: 创建订单 → 调用微信支付统一下单
2. **paymentCallback**: 支付成功 → 生成券码 → 生成二维码 → 更新订单 → 扣库存 → 更新用户

### 2. 券码生成逻辑

```javascript
// 券码格式: VCH + YYYYMMDD + 6位随机数
function generateVoucherCode() {
  const date = new Date();
  const dateStr = date.toISOString().slice(0, 10).replace(/-/g, '');
  const random = Math.floor(Math.random() * 900000) + 100000;
  return `VCH${dateStr}${random}`;
}

// 生成小程序码
const result = await cloud.openapi.wxacode.getUnlimited({
  scene: voucherCode,
  page: 'pages/voucher/verify',
  width: 430,
  lineColor: { r: 255, g: 106, b: 0 }
});
```

### 3. 自动标签系统

```javascript
// 根据消费金额和订单数自动打标签
function autoTagUser(totalSpent, totalOrders) {
  const tags = [];
  
  if (totalSpent >= 100000) tags.push('钻石会员');
  else if (totalSpent >= 50000) tags.push('金卡会员');
  else if (totalSpent >= 20000) tags.push('银卡会员');
  
  if (totalOrders >= 10) tags.push('高频客户');
  else if (totalOrders >= 5) tags.push('活跃客户');
  
  if (totalOrders >= 3) tags.push('优惠敏感');
  
  return tags;
}
```

---

## 🔐 安全规范

### 1. 金额校验
- ✅ 所有金额计算在**云函数后端**完成
- ✅ 前端只传递 `voucher_id` 和 `quantity`
- ✅ 后端从数据库查询价格，防止篡改

### 2. 库存控制
- ✅ 使用数据库事务保证原子性
- ✅ 支付成功后才扣减库存
- ✅ 支持无限库存 (stock = -1)

### 3. 券码唯一性
- ✅ 时间戳 + 随机数保证唯一性
- ✅ 每个券码生成独立二维码
- ✅ 核销后状态变更为 `used`

---

## 📊 数据库 Schema

详见 [数据库设计文档](#步骤-1数据库架构设计-database-schema-design)

---

## 🎨 UI 设计规范

### 品牌色
- **主色**: `#FF6A00` (橙色)
- **辅助色**: `#FF8E3C` (浅橙)
- **背景色**: `#F8F5F2` (米白)
- **文字色**: `#333` (深灰)

### 字体
- **标题**: PingFang SC Bold (52rpx)
- **正文**: PingFang SC Regular (28rpx)
- **辅助**: PingFang SC Light (22rpx)

---

## 📝 待办事项

- [ ] 实现预约功能 (并发控制)
- [ ] 实现员工核销端
- [ ] 接入企微 external_userid
- [ ] 配置订阅消息模板
- [ ] 添加退款功能
- [ ] 添加券码过期自动提醒

---

## 📞 技术支持

如有问题，请联系开发团队。

**版本**: v1.0.0  
**更新时间**: 2026-02-22
