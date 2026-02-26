// 云函数入口文件
const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const _ = db.command;

/**
 * 生成唯一订单号
 * 格式: ORD + YYYYMMDD + 6位随机数
 */
function generateOrderNo() {
  const date = new Date();
  const dateStr = date.toISOString().slice(0, 10).replace(/-/g, '');
  const random = Math.floor(Math.random() * 900000) + 100000;
  return `ORD${dateStr}${random}`;
}

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
      page: 'pages/voucher/detail',
      width: 430,
      autoColor: false,
      lineColor: { r: 255, g: 106, b: 0 }, // 橙色主题
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
    throw new Error('二维码生成失败');
  }
}

/**
 * 创建支付订单
 * 云函数入口函数
 */
exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext();
  const { voucher_id, quantity = 1 } = event;

  // ========== 1. 参数校验 ==========
  if (!voucher_id) {
    return {
      success: false,
      errMsg: '缺少必要参数: voucher_id'
    };
  }

  if (quantity < 1 || quantity > 10) {
    return {
      success: false,
      errMsg: '购买数量必须在 1-10 之间'
    };
  }

  try {
    // ========== 2. 查询券模板信息 ==========
    const voucherDoc = await db.collection('Vouchers')
      .doc(voucher_id)
      .get();

    if (!voucherDoc.data) {
      return {
        success: false,
        errMsg: '券不存在或已下架'
      };
    }

    const voucher = voucherDoc.data;

    // 检查券是否上架
    if (!voucher.is_active) {
      return {
        success: false,
        errMsg: '该券已下架'
      };
    }

    // 检查库存 (stock = -1 表示无限库存)
    if (voucher.stock !== -1 && voucher.stock < quantity) {
      return {
        success: false,
        errMsg: `库存不足，剩余 ${voucher.stock} 张`
      };
    }

    // ========== 3. 计算订单金额 ==========
    const unitPrice = voucher.price; // 单价 (分)
    const totalAmount = unitPrice * quantity; // 总金额 (分)

    // ========== 4. 创建订单记录 (预支付状态) ==========
    const orderNo = generateOrderNo();
    const now = new Date();

    const orderData = {
      _openid: OPENID,
      order_no: orderNo,
      type: 'voucher',
      items: [
        {
          voucher_id: voucher._id,
          name: voucher.name,
          quantity: quantity,
          price: unitPrice,
          subtotal: totalAmount
        }
      ],
      total_amount: totalAmount,
      paid_amount: 0,
      discount_amount: 0,
      payment_method: 'wechat',
      payment_status: 'pending',
      voucher_codes: [], // 支付成功后填充
      created_at: db.serverDate(),
      updated_at: db.serverDate()
    };

    const orderResult = await db.collection('Orders').add({
      data: orderData
    });

    const orderId = orderResult._id;

    // ========== 5. 调用微信支付统一下单接口 ==========
    const paymentResult = await cloud.cloudPay.unifiedOrder({
      body: `年年有喜-${voucher.name}`,
      outTradeNo: orderNo,
      spbillCreateIp: '127.0.0.1', // 云函数固定IP
      subMchId: '', // 子商户号 (如有)
      totalFee: totalAmount, // 单位: 分
      envId: cloud.DYNAMIC_CURRENT_ENV,
      functionName: 'paymentCallback', // 支付回调云函数名称
      nonceStr: Math.random().toString(36).substr(2, 15),
      tradeType: 'JSAPI',
      openid: OPENID
    });

    // ========== 6. 返回支付参数给前端 ==========
    return {
      success: true,
      data: {
        order_id: orderId,
        order_no: orderNo,
        payment: paymentResult.payment, // 包含 timeStamp, nonceStr, package, signType, paySign
        total_amount: totalAmount
      }
    };

  } catch (err) {
    console.error('创建支付订单失败:', err);
    return {
      success: false,
      errMsg: err.message || '系统错误，请稍后重试'
    };
  }
};
