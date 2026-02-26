// pages/index/index.js
Page({
  data: {
    isFromScan: false,
    scanParams: null,
    showAuthModal: false,
    showLegacyMemberTip: false,
    legacyMemberPoints: 0
  },

  onLoad: function(options) {
    console.log('onLoad options:', options);
    try {
      var app = getApp();
      if (!app.globalData.__debug_modal_shown__) {
        app.globalData.__debug_modal_shown__ = true;
        wx.showModal({
          title: '真机调试',
          content: 'onLoad 已执行',
          showCancel: false
        });
      }
      var scanParams = app.globalData && app.globalData.scanParams;
      console.log('scanParams:', scanParams);
      if (scanParams) {
        this.setData({ isFromScan: true, scanParams: scanParams, showAuthModal: true });
      }
    } catch (e) {
      console.error('onLoad error:', e);
    }
  },

  onGetPhoneNumber: function(e) {
    console.log('授权回调:', e);
    if (!e.detail || !e.detail.errMsg) {
      wx.showToast({ title: '授权失败，请重试', icon: 'none' });
      return;
    }

    if (e.detail.errMsg !== 'getPhoneNumber:ok') {
      if (String(e.detail.errMsg).indexOf('no permission') >= 0) {
        wx.showModal({
          title: '无法获取手机号',
          content: '请确认小程序后台已开启"获取手机号"接口权限',
          showCancel: false
        });
        return;
      }
      wx.showToast({ title: '用户拒绝授权', icon: 'none' });
      return;
    }

    if (!wx.cloud || !wx.cloud.callFunction) {
      wx.showModal({
        title: '云能力未初始化',
        content: '请确认已选择云开发环境并重新预览。',
        showCancel: false
      });
      return;
    }

    wx.showLoading({ title: '正在入会...' });
    var self = this;
    
    wx.cloud.callFunction({
      name: 'saveUserPhone',
      data: {
        code: e.detail.code,
        scanParams: self.data.scanParams
      },
      success: function(result) {
        wx.hideLoading();
        console.log('云函数结果:', result);
        self.setData({ showAuthModal: false });
        
        var data = result.result && result.result.data;
        if (data && data.isLegacyMember && data.legacyPoints > 0) {
          self.setData({ showLegacyMemberTip: true, legacyMemberPoints: data.legacyPoints });
          setTimeout(function() {
            self.setData({ showLegacyMemberTip: false });
            self.navigateToKeruYun();
          }, 1500);
        } else {
          self.navigateToKeruYun();
        }
      },
      fail: function(err) {
        wx.hideLoading();
        console.error('云函数失败:', err);
        wx.showToast({ title: '入会失败，请重试', icon: 'none' });
      }
    });
  },

  onAuthTap: function() {
    console.log('点击授权按钮');
  },

  navigateToKeruYun: function() {
    var app = getApp();
    var config = app.globalData.keruYunConfig;
    var params = this.data.scanParams || {};
    // 暂时注释掉具体路径，测试是否能正常打开客如云首页
    // var path = (config.path || 'pages/order/index') + '?table_id=' + (params.table_id || '') + '&store_id=' + (params.store_id || '');
    
    console.log('准备跳转客如云，AppID:', config.appId);
    
    wx.navigateToMiniProgram({
      appId: config.appId,
      // path: path, // 暂不传 path，默认打开首页
      envVersion: 'release', // 默认打开正式版
      fail: function(err) {
        console.error('跳转失败:', err);
        // 弹窗显示完整错误信息
        wx.showModal({
          title: '跳转失败',
          content: '错误: ' + (err.errMsg || JSON.stringify(err)),
          showCancel: false
        });
      }
    });
  }
});
