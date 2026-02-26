// 云函数入口文件 - 保存用户手机号并检测老会员
const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const _ = db.command;

/**
 * 检测是否为老会员
 * 从客如云导入的老会员数据存储在 LegacyMembers 集合
 * @param {string} phone - 手机号
 * @returns {Promise<Object>} { isLegacy, points }
 */
async function checkLegacyMember(phone) {
  try {
    const res = await db.collection('LegacyMembers')
      .where({
        phone: phone,
        is_synced: false // 未同步到新系统
      })
      .get();

    if (res.data.length > 0) {
      const legacyData = res.data[0];
      return {
        isLegacy: true,
        points: legacyData.points || 0,
        total_spent: legacyData.total_spent || 0,
        member_level: legacyData.member_level || '普通',
        legacy_id: legacyData._id
      };
    }

    return {
      isLegacy: false,
      points: 0
    };
  } catch (err) {
    console.error('检测老会员失败:', err);
    return {
      isLegacy: false,
      points: 0
    };
  }
}

/**
 * 标记老会员已同步
 */
async function markLegacyMemberSynced(legacyId) {
  try {
    await db.collection('LegacyMembers')
      .doc(legacyId)
      .update({
        data: {
          is_synced: true,
          synced_at: db.serverDate()
        }
      });
  } catch (err) {
    console.error('标记老会员同步失败:', err);
  }
}

/**
 * 云函数入口
 * 保存用户手机号并检测老会员
 */
exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext();
  const { code, scanParams } = event;

  // ========== 1. 参数校验 ==========
  if (!code) {
    return {
      success: false,
      errMsg: '缺少必要参数: code'
    };
  }

  try {
    // ========== 2. 获取手机号 ==========
    // 使用 code 换取手机号 (微信新版接口)
    let phoneNumber = '';
    
    try {
      const phoneResult = await cloud.openapi.phonenumber.getPhoneNumber({
        code: code
      });

      if (phoneResult.errcode === 0) {
        phoneNumber = phoneResult.phone_info.phoneNumber;
      } else {
        throw new Error('获取手机号失败: ' + phoneResult.errmsg);
      }
    } catch (err) {
      console.error('获取手机号失败:', err);
      return {
        success: false,
        errMsg: '获取手机号失败，请重试'
      };
    }

    console.log('获取到手机号:', phoneNumber);

    // ========== 3. 检测老会员 ==========
    const legacyCheck = await checkLegacyMember(phoneNumber);
    const { isLegacy, points, total_spent, member_level, legacy_id } = legacyCheck;

    console.log('老会员检测结果:', legacyCheck);

    // ========== 4. 查询用户是否已存在 ==========
    const userQuery = await db.collection('Users')
      .where({
        _openid: OPENID
      })
      .get();

    const now = new Date();
    const userData = {
      phone: phoneNumber,
      updated_at: db.serverDate(),
      last_visit: db.serverDate()
    };

    // 如果是老会员，同步数据
    if (isLegacy) {
      userData.total_spent = total_spent;
      userData.member_level = member_level;
      userData.legacy_points = points; // 保留老积分记录
      userData.is_legacy_member = true;
      userData.legacy_synced_at = db.serverDate();
    }

    // 记录扫码信息
    if (scanParams) {
      userData.last_scan = {
        table_id: scanParams.table_id,
        store_id: scanParams.store_id,
        timestamp: scanParams.timestamp || Date.now()
      };
    }

    if (userQuery.data.length > 0) {
      // ========== 5. 更新已有用户 ==========
      const userId = userQuery.data[0]._id;
      
      await db.collection('Users')
        .doc(userId)
        .update({
          data: userData
        });

      console.log('用户信息已更新:', userId);
    } else {
      // ========== 6. 创建新用户 ==========
      const newUserData = {
        _openid: OPENID,
        ...userData,
        total_spent: userData.total_spent || 0,
        total_orders: 0,
        member_level: userData.member_level || '普通',
        tags: [],
        vouchers: [],
        created_at: db.serverDate()
      };

      await db.collection('Users').add({
        data: newUserData
      });

      console.log('新用户已创建');
    }

    // ========== 7. 标记老会员已同步 ==========
    if (isLegacy && legacy_id) {
      await markLegacyMemberSynced(legacy_id);
    }

    // ========== 8. 记录扫码日志 ==========
    if (scanParams) {
      await db.collection('ScanLogs').add({
        data: {
          _openid: OPENID,
          phone: phoneNumber,
          table_id: scanParams.table_id,
          store_id: scanParams.store_id,
          is_legacy_member: isLegacy,
          legacy_points: points,
          created_at: db.serverDate()
        }
      });
    }

    // ========== 9. 返回结果 ==========
    return {
      success: true,
      data: {
        phone: phoneNumber,
        isLegacyMember: isLegacy,
        legacyPoints: points
      }
    };

  } catch (err) {
    console.error('保存用户信息失败:', err);
    return {
      success: false,
      errMsg: err.message || '系统错误，请稍后重试'
    };
  }
};
