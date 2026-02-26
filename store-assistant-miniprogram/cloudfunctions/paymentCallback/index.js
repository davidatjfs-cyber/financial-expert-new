// 云函数入口文件 - 支付回调处理
const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const _ = db.command;

/**
 * 生成唯一券码
 * 格式: VCH + YYYYMMDD + 6位随机数
 */
function generateVoucherCode() {
  const date = new Date();
  const dateStr = date.toISOString().slice(0, 10).replace(/-/g, '');
  const random = Math.floor(Math.random() * 900000) + 100000;
  return `VCH${dateStr}${random}`;
}

/**
 * 生成券码二维码
 * @param {string} voucherCode - 券码
 * @returns {Promise<string>} 二维码云存储路径
 */
async function generateQRCode(voucherCode) {
  try {
    // 调用微信接口生成小程序码
    const result = await cloud.openapi.wxacode.getUnlimited({
      scene: voucherCode,
      page: 'pages/voucher/verify',
      width: 430,
      autoColor: false,
      lineColor: { r: 255, g: 106, b: 0 },
      isHyaline: true
    });

    // 上传到云存储
    const uploadResult = await cloud.uploadFile({
      cloudPath: `qrcodes/${voucherCode}.png`,
      fileContent: result.buffer
    });

    return uploadResult.fileID;
  } catch (err) {
    console.error('生成二维码失败:', err);
    // 降级方案: 返回文本券码
    return null;
  }
}

/**
 * 自动打标签
 * 根据用户消费行为自动打标签
 */
async function autoTagUser(openid, totalSpent, totalOrders) {
  const tags = [];

  // 消费金额标签
  if (totalSpent >= 100000) tags.push('钻石会员'); // 1000元
  else if (totalSpent >= 50000) tags.push('金卡会员'); // 500元
  else if (totalSpent >= 20000) tags.push('银卡会员'); // 200元

  // 消费频次标签
  if (totalOrders >= 10) tags.push('高频客户');
  else if (totalOrders >= 5) tags.push('活跃客户');

  // 优惠敏感度 (购买代金券次数)
  if (totalOrders >= 3) tags.push('优惠敏感');

  return tags;
}

/**
 * 支付回调云函数入口
 * 微信支付成功后自动调用
 */
exports.main = async (event, context) => {
  console.log('支付回调事件:', event);

  const { returnCode, resultCode, outTradeNo, transactionId, totalFee } = event;

  // ========== 1. 校验支付结果 ==========
  if (returnCode !== 'SUCCESS' || resultCode !== 'SUCCESS') {
    console.error('支付失败:', event);
    return { errcode: -1, errmsg: '支付失败' };
  }

  try {
    // ========== 2. 查询订单信息 ==========
    const orderQuery = await db.collection('Orders')
      .where({
        order_no: outTradeNo,
        payment_status: 'pending'
      })
      .get();

    if (orderQuery.data.length === 0) {
      console.error('订单不存在或已处理:', outTradeNo);
      return { errcode: 0, errmsg: '订单已处理' };
    }

    const order = orderQuery.data[0];
    const orderId = order._id;
    const userOpenid = order._openid;

    // ========== 3. 生成券码和二维码 ==========
    const voucherCodes = [];
    const voucherItem = order.items[0]; // 当前只支持单券种购买
    const quantity = voucherItem.quantity;

    // 查询券模板信息 (获取有效期)
    const voucherDoc = await db.collection('Vouchers')
      .doc(voucherItem.voucher_id)
      .get();

    const voucherTemplate = voucherDoc.data;
    const validDays = voucherTemplate.valid_days || 30;
    const expireDate = new Date(Date.now() + validDays * 24 * 60 * 60 * 1000);

    // 批量生成券码
    for (let i = 0; i < quantity; i++) {
      const code = generateVoucherCode();
      const qrCodeUrl = await generateQRCode(code);

      voucherCodes.push({
        code: code,
        qr_code_url: qrCodeUrl,
        status: 'unused',
        used_at: null,
        used_by_staff: null,
        expire_date: expireDate
      });
    }

    // ========== 4. 更新订单状态 ==========
    await db.collection('Orders').doc(orderId).update({
      data: {
        payment_status: 'paid',
        paid_amount: totalFee,
        transaction_id: transactionId,
        paid_at: db.serverDate(),
        voucher_codes: voucherCodes,
        updated_at: db.serverDate()
      }
    });

    // ========== 5. 扣减券库存 ==========
    if (voucherTemplate.stock !== -1) {
      await db.collection('Vouchers')
        .doc(voucherItem.voucher_id)
        .update({
          data: {
            stock: _.inc(-quantity),
            sold_count: _.inc(quantity),
            updated_at: db.serverDate()
          }
        });
    } else {
      // 无限库存只增加销量
      await db.collection('Vouchers')
        .doc(voucherItem.voucher_id)
        .update({
          data: {
            sold_count: _.inc(quantity),
            updated_at: db.serverDate()
          }
        });
    }

    // ========== 6. 更新用户信息 ==========
    const userQuery = await db.collection('Users')
      .where({ _openid: userOpenid })
      .get();

    let newTotalSpent = totalFee;
    let newTotalOrders = 1;

    if (userQuery.data.length > 0) {
      // 用户已存在，累加数据
      const user = userQuery.data[0];
      newTotalSpent = (user.total_spent || 0) + totalFee;
      newTotalOrders = (user.total_orders || 0) + 1;

      // 自动打标签
      const autoTags = await autoTagUser(userOpenid, newTotalSpent, newTotalOrders);

      // 更新用户券包
      const updatedVouchers = (user.vouchers || []).concat(
        voucherCodes.map(vc => ({
          voucher_id: voucherItem.voucher_id,
          voucher_name: voucherItem.name,
          code: vc.code,
          status: 'unused',
          qr_code: vc.qr_code_url,
          expire_date: vc.expire_date,
          order_id: orderId
        }))
      );

      await db.collection('Users').doc(user._id).update({
        data: {
          total_spent: newTotalSpent,
          total_orders: newTotalOrders,
          tags: autoTags,
          vouchers: updatedVouchers,
          last_visit: db.serverDate(),
          updated_at: db.serverDate()
        }
      });
    } else {
      // 新用户，创建记录
      const autoTags = await autoTagUser(userOpenid, newTotalSpent, newTotalOrders);

      await db.collection('Users').add({
        data: {
          _openid: userOpenid,
          total_spent: newTotalSpent,
          total_orders: newTotalOrders,
          tags: autoTags,
          vouchers: voucherCodes.map(vc => ({
            voucher_id: voucherItem.voucher_id,
            voucher_name: voucherItem.name,
            code: vc.code,
            status: 'unused',
            qr_code: vc.qr_code_url,
            expire_date: vc.expire_date,
            order_id: orderId
          })),
          member_level: '普通',
          created_at: db.serverDate(),
          updated_at: db.serverDate(),
          last_visit: db.serverDate()
        }
      });
    }

    // ========== 7. 发送订阅消息通知 ==========
    try {
      await cloud.openapi.subscribeMessage.send({
        touser: userOpenid,
        page: 'pages/voucher/list',
        data: {
          thing1: { value: voucherItem.name },
          amount2: { value: `¥${(totalFee / 100).toFixed(2)}` },
          number3: { value: quantity.toString() },
          date4: { value: new Date().toLocaleString('zh-CN') }
        },
        templateId: 'YOUR_TEMPLATE_ID', // 需要在微信公众平台配置
        miniprogramState: 'formal'
      });
    } catch (msgErr) {
      console.error('发送订阅消息失败:', msgErr);
      // 不影响主流程
    }

    console.log('支付回调处理成功:', {
      order_no: outTradeNo,
      voucher_count: voucherCodes.length
    });

    return {
      errcode: 0,
      errmsg: 'success'
    };

  } catch (err) {
    console.error('支付回调处理失败:', err);
    return {
      errcode: -1,
      errmsg: err.message
    };
  }
};
