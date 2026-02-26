# 门店私域助手 - 部署与测试指南

## 📋 目录结构

```
store-assistant-miniprogram/
├── cloudfunctions/              # 云函数目录
│   ├── createPayment/          # 创建支付订单
│   │   ├── index.js
│   │   ├── config.json
│   │   └── package.json
│   └── paymentCallback/        # 支付回调处理
│       ├── index.js
│       ├── config.json
│       └── package.json
├── pages/                      # 页面目录
│   └── index/
│       ├── index.js           # 首页逻辑
│       ├── index.wxml         # 首页结构
│       ├── index.wxss         # 首页样式
│       └── index.json         # 页面配置
├── app.js                     # 小程序入口
├── app.json                   # 全局配置
├── project.config.json        # 项目配置
└── README.md                  # 项目说明
```

---

## 🚀 快速开始

### 步骤 1: 克隆项目并安装依赖

```bash
# 进入云函数目录
cd cloudfunctions/createPayment
npm install

cd ../paymentCallback
npm install
```

### 步骤 2: 配置环境

#### 2.1 修改 `app.js`
```javascript
wx.cloud.init({
  env: 'cloud1-xxxxx', // 替换为你的云开发环境 ID
  traceUser: true
});
```

#### 2.2 修改 `project.config.json`
```json
{
  "appid": "wx1234567890abcdef" // 替换为你的小程序 AppID
}
```

### 步骤 3: 上传云函数

在微信开发者工具中:
1. 右键 `cloudfunctions/createPayment` → "上传并部署: 云端安装依赖"
2. 右键 `cloudfunctions/paymentCallback` → "上传并部署: 云端安装依赖"

### 步骤 4: 初始化数据库

在云开发控制台 → 数据库 → 添加集合:

| 集合名 | 说明 | 权限设置 |
|--------|------|---------|
| Users | 用户表 | 仅创建者可读写 |
| Vouchers | 券模板表 | 所有用户可读，仅管理员可写 |
| Orders | 订单表 | 仅创建者可读写 |
| Staff | 员工表 | 仅管理员可读写 |

### 步骤 5: 添加测试数据

在 `Vouchers` 集合中添加测试券:

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
  "description": "全场通用 · 洪潮/马己仙可用",
  "sort_order": 1,
  "is_active": true
}
```

---

## 🧪 测试流程

### 测试 1: 券列表加载

1. 打开小程序首页
2. 检查券列表是否正常显示
3. 验证券信息 (名称、价格、描述) 是否正确

**预期结果**: 显示测试券卡片，价格为 ¥80.00

---

### 测试 2: 支付流程 (沙箱环境)

#### 2.1 配置微信支付沙箱

1. 登录 [微信支付商户平台](https://pay.weixin.qq.com/)
2. 账户中心 → API安全 → 设置API密钥
3. 产品中心 → 开发配置 → 沙箱环境

#### 2.2 执行支付测试

1. 点击 "BUY NOW" 按钮
2. 确认购买弹窗
3. 输入沙箱支付密码 (默认: `123456`)
4. 等待支付成功提示

**预期结果**:
- ✅ 订单创建成功
- ✅ 支付成功跳转到券包页面
- ✅ 数据库 `Orders` 集合新增记录，`payment_status` = `paid`
- ✅ `Users` 集合更新，`vouchers` 数组新增券码
- ✅ `Vouchers` 集合库存减 1

---

### 测试 3: 券码生成验证

#### 3.1 检查订单记录

在云开发控制台 → 数据库 → `Orders`:

```json
{
  "order_no": "ORD20260222123456",
  "payment_status": "paid",
  "voucher_codes": [
    {
      "code": "VCH20260222654321",
      "qr_code_url": "cloud://xxx.png",
      "status": "unused",
      "expire_date": "2026-03-24T..."
    }
  ]
}
```

#### 3.2 检查用户券包

在云开发控制台 → 数据库 → `Users`:

```json
{
  "_openid": "oXXXX...",
  "total_spent": 8000,
  "total_orders": 1,
  "tags": ["活跃客户"],
  "vouchers": [
    {
      "voucher_id": "xxx",
      "code": "VCH20260222654321",
      "status": "unused",
      "qr_code": "cloud://xxx.png"
    }
  ]
}
```

---

### 测试 4: 自动标签验证

| 消费金额 | 订单数 | 预期标签 |
|---------|--------|---------|
| ¥200 | 1 | `["银卡会员"]` |
| ¥500 | 5 | `["金卡会员", "活跃客户", "优惠敏感"]` |
| ¥1000 | 10 | `["钻石会员", "高频客户", "优惠敏感"]` |

**测试方法**: 多次购买券，检查 `Users.tags` 字段变化

---

## 🔧 常见问题排查

### 问题 1: 云函数调用失败

**错误信息**: `errCode: -404011, errMsg: cloud function execution error`

**解决方案**:
1. 检查云函数是否已上传
2. 在云开发控制台 → 云函数 → 查看日志
3. 确认 `wx-server-sdk` 版本 >= 2.6.3

---

### 问题 2: 支付失败

**错误信息**: `调用支付JSAPI缺少参数`

**解决方案**:
1. 检查 `createPayment` 云函数是否正确返回 `payment` 对象
2. 确认商户号已配置
3. 检查支付目录是否正确

---

### 问题 3: 二维码生成失败

**错误信息**: `生成二维码失败`

**解决方案**:
1. 检查云函数权限配置 (`config.json`)
2. 确认 `wxacode.getUnlimited` 接口已开通
3. 检查 `scene` 参数长度 (最大 32 字符)

---

### 问题 4: 库存未扣减

**原因**: 支付回调未触发

**解决方案**:
1. 检查 `paymentCallback` 云函数是否已上传
2. 在微信支付商户平台配置回调 URL
3. 查看云函数日志确认是否收到回调

---

## 📊 性能优化建议

### 1. 数据库索引

在云开发控制台 → 数据库 → 索引管理:

```javascript
// Users 集合
db.collection('Users').createIndex({
  _openid: 1
});

// Orders 集合
db.collection('Orders').createIndex({
  order_no: 1
});
db.collection('Orders').createIndex({
  _openid: 1,
  created_at: -1
});

// Vouchers 集合
db.collection('Vouchers').createIndex({
  is_active: 1,
  sort_order: 1
});
```

### 2. 云函数并发优化

在 `paymentCallback` 中使用数据库事务:

```javascript
const transaction = await db.startTransaction();

try {
  // 更新订单
  await transaction.collection('Orders').doc(orderId).update({...});
  
  // 扣减库存
  await transaction.collection('Vouchers').doc(voucherId).update({...});
  
  // 提交事务
  await transaction.commit();
} catch (err) {
  await transaction.rollback();
}
```

### 3. 图片优化

- 二维码使用 WebP 格式 (减少 30% 体积)
- 设置云存储 CDN 加速
- 启用图片懒加载

---

## 🔐 安全检查清单

- [ ] 所有金额计算在云函数后端完成
- [ ] 前端不可直接修改订单状态
- [ ] 数据库权限配置正确
- [ ] 支付回调验证签名
- [ ] 券码唯一性校验
- [ ] 库存并发控制
- [ ] 敏感信息加密存储

---

## 📈 监控指标

### 关键指标

| 指标 | 目标值 | 监控方式 |
|------|--------|---------|
| 支付成功率 | > 95% | 云开发控制台 → 统计分析 |
| 云函数平均响应时间 | < 500ms | 云函数日志 |
| 数据库查询耗时 | < 200ms | 慢查询日志 |
| 二维码生成成功率 | > 99% | 云函数日志 |

---

## 🎯 下一步计划

- [ ] 实现预约功能 (并发库存控制)
- [ ] 开发员工核销端
- [ ] 接入企微 external_userid
- [ ] 添加退款功能
- [ ] 配置订阅消息模板
- [ ] 添加数据统计看板

---

## 📞 技术支持

遇到问题请查看:
1. [微信小程序官方文档](https://developers.weixin.qq.com/miniprogram/dev/framework/)
2. [云开发文档](https://developers.weixin.qq.com/miniprogram/dev/wxcloud/basis/getting-started.html)
3. [微信支付文档](https://pay.weixin.qq.com/wiki/doc/apiv3/index.shtml)

**版本**: v1.0.0  
**最后更新**: 2026-02-22
