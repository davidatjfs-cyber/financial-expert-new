// app.js
App({
  onLaunch: function (options) {
    // 检查云开发环境
    if (!wx.cloud) {
      console.error('请使用 2.2.3 或以上的基础库以使用云能力');
    } else {
      // 初始化云开发环境
      wx.cloud.init({
        env: 'cloud1-2gqo1169d58023d7', // 云开发环境ID
        traceUser: true
      });
    }

    // 解析启动参数
    this.parseLaunchOptions(options);

    console.log('=== app onLaunch 完成 ===');
    console.log('globalData:', this.globalData);
  },

  onShow: function (options) {
    // 每次显示时也解析参数 (处理从后台回到前台的情况)
    this.parseLaunchOptions(options);
  },

  /**
   * 解析启动参数
   */
  parseLaunchOptions(options) {
    const { scene, query } = options;
    
    console.log('解析启动参数:', { scene, query });
    
    // 临时测试参数 (模拟扫码)
    this.globalData.scanParams = {
      table_id: 'T01',
      store_id: 'hongchao_daning',
      scene: 1047,
      timestamp: Date.now()
    };
    console.log('设置测试扫码参数:', this.globalData.scanParams);
    
    // 场景值: 1047 扫描小程序码, 1011 扫描二维码
    if (scene === 1047 || scene === 1011) {
      if (query && (query.table_id || query.store_id)) {
        this.globalData.scanParams = {
          table_id: query.table_id || '',
          store_id: query.store_id || '',
          scene: scene,
          timestamp: Date.now()
        };
        console.log('设置真实扫码参数:', this.globalData.scanParams);
      }
    }
  },

  globalData: {
    userInfo: null,
    isStaff: false,
    staffInfo: null,
    // 扫码进入参数
    scanParams: null,
    // 客如云小程序配置
    keruYunConfig: {
      appId: 'wxdaa8741d326cf971', // 客如云小程序 AppID
      path: 'pages/order/index'     // 替换为客如云点餐页面路径
    }
  },

  /**
   * 检查用户是否为员工
   */
  async checkStaffStatus() {
    try {
      const db = wx.cloud.database();
      const res = await db.collection('Staff')
        .where({
          _openid: '{openid}',
          is_active: true
        })
        .get();

      if (res.data.length > 0) {
        this.globalData.isStaff = true;
        this.globalData.staffInfo = res.data[0];
        return true;
      }
      return false;
    } catch (err) {
      console.error('检查员工状态失败:', err);
      return false;
    }
  }
});
