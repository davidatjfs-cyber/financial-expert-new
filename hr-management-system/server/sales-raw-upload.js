let _pool = null;
export function setSalesRawPool(p) { _pool = p; }
function gp() { if (!_pool) throw new Error('pool not set'); return _pool; }

export function parseSalesRawRows(matrix, defBiz, defStore, opts = {}) {
  const R = Array.isArray(matrix) ? matrix : []; if (!R.length) return [];
  const n = x => String(x||'').trim();
  const c = x => n(x).toLowerCase().replace(/[\s\/:：()（）\[\]【】_\-~～]/g,'');
  let hri = -1;
  for (let i=0;i<R.length;i++){
    const h=(Array.isArray(R[i])?R[i]:[]).map(c);
    const t=p=>h.some(x=>p.test(x));
    if(t(/菜品名称|商品名称|品名/)&&(t(/销售数量|数量/)||t(/销售金额|金额/))){hri=i;break;}
  }
  const ds=hri>=0?hri+1:0;
  const hdr=hri>=0&&Array.isArray(R[hri])?R[hri]:[];
  const hdrs=hdr.map(c);
  const idx=ns=>{for(const x of ns){const i=hdrs.indexOf(c(x));if(i>=0)return i;}return -1;};
  const iD=idx(['销售日期','日期','营业日期']);
  const iB=idx(['销售类型','类型']);
  const iS=idx(['餐/时段名称','时段名称','餐时段','时段']);
  const iP=idx(['菜品名称','商品名称','品名','产品']);
  const iQ=idx(['销售数量','数量']);
  const iA=idx(['销售金额','销售额','销售收入','折前营收','金额']);
  const iR=idx(['实际收入','实收','菜品收入','家品收入','折后营收','折后收入']);
  const iDi=idx(['优惠金额','优惠','折扣']);
  const iOT=idx(['下单时间','点单时间','订单时间']);
  const iCT=idx(['结账时间','结算时间']);
  const iSt=idx(['门店','店铺','门店名称']);
  const pn=v=>{const s=String(v==null?'':v).replace(/[,，\s¥￥]/g,'');if(!s)return NaN;const x=Number(s);return Number.isFinite(x)?x:NaN;};
  const nd=v=>{const s=n(v);const m=s.match(/(\d{4})[\/\-年](\d{1,2})[\/\-月](\d{1,2})/);return m?`${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`:'';}
  const nb=v=>{const s=n(v).toLowerCase();if(/外卖|takeaway|delivery/.test(s))return'takeaway';if(/堂食|dinein/.test(s))return'dinein';return'';};
  const ns=v=>{const s=n(v);if(/午市|lunch/.test(s))return'lunch';if(/下午茶|afternoon/.test(s))return'afternoon';if(/晚市|dinner/.test(s))return'dinner';const m=s.match(/(\d{1,2})\s*[:：]/);if(m){const h=+m[1];if(h>=10&&h<14)return'lunch';if(h>=14&&h<17)return'afternoon';if(h>=17&&h<22)return'dinner';}return'';};
  const res=[];
  for(let r=ds;r<R.length;r++){
    const L=Array.isArray(R[r])?R[r]:[];if(!L.length)continue;
    const prod=n(iP>=0?L[iP]:'');const qty=pn(iQ>=0?L[iQ]:0);
    if(!prod||!Number.isFinite(qty)||qty<=0)continue;
    const date=nd(iD>=0?L[iD]:'')||(opts.fallbackDate||'');if(!date)continue;
    const biz=nb(iB>=0?L[iB]:'')||defBiz||'dinein';
    const store=n(iSt>=0?L[iSt]:'')||defStore||'';
    let slot=iS>=0?ns(L[iS]):'';
    if(!slot&&iOT>=0)slot=ns(L[iOT]);
    if(!slot&&iCT>=0)slot=ns(L[iCT]);
    if(!slot)slot='other';
    const sa=(()=>{const x=pn(iA>=0?L[iA]:0);return Number.isFinite(x)?Math.max(0,x):0;})();
    const rv=(()=>{const x=pn(iR>=0?L[iR]:0);return Number.isFinite(x)&&x>0?x:0;})();
    const di=(()=>{const x=pn(iDi>=0?L[iDi]:0);return Number.isFinite(x)?Math.abs(x):0;})();
    const revenue=rv>0?rv:Math.max(0,sa-di);
    const wd=(()=>{const d=new Date(date+'T00:00:00');const w=d.getDay();return w===0?7:w;})();
    let oTime=null,cTime=null;
    if(iOT>=0){try{const t=n(L[iOT]).replace(/：/g,':');const d=new Date(`${date}T${t}`);if(!isNaN(d))oTime=d.toISOString();}catch(e){}}
    if(iCT>=0){try{const t=n(L[iCT]).replace(/：/g,':');const d=new Date(`${date}T${t}`);if(!isNaN(d))cTime=d.toISOString();}catch(e){}}
    res.push({store,date,biz_type:biz,dish_name:prod,qty:+qty.toFixed(2),sales_amount:+sa.toFixed(2),revenue:+revenue.toFixed(2),discount:+di.toFixed(2),slot,order_time:oTime,checkout_time:cTime,weekday:wd});
  }
  return res;
}

export async function insertSalesRawRows(rows, store, bizType, minDate, maxDate) {
  const p = gp();
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    const del = await client.query('DELETE FROM sales_raw WHERE store=$1 AND biz_type=$2 AND date BETWEEN $3 AND $4',[store,bizType,minDate,maxDate]);
    console.log(`[sales-raw] deleted ${del.rowCount} old rows ${store}/${bizType} ${minDate}~${maxDate}`);
    let cnt=0;
    for(const r of rows){
      await client.query(`INSERT INTO sales_raw(store,date,biz_type,dish_name,qty,sales_amount,revenue,discount,slot,order_time,checkout_time,weekday) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [r.store,r.date,r.biz_type,r.dish_name,r.qty,r.sales_amount,r.revenue,r.discount,r.slot,r.order_time,r.checkout_time,r.weekday]);
      cnt++;
    }
    await client.query('COMMIT');
    return {deleted:del.rowCount,inserted:cnt};
  } catch(e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
