'use client';

import { useEffect, useMemo, useState, type FormEvent } from 'react';
import styles from './AdminDashboard.module.css';

type Row = Record<string, any>;
type Section = 'overview' | 'orders' | 'categories' | 'products' | 'banners' | 'settings' | 'content' | 'reviews';
const nav: Array<{ id: Section; label: string; icon: string }> = [
  { id: 'overview', label: 'الرئيسية', icon: '⌂' }, { id: 'orders', label: 'الطلبات', icon: '▤' },
  { id: 'products', label: 'المنتجات', icon: '▣' }, { id: 'categories', label: 'الأقسام', icon: '▦' },
  { id: 'banners', label: 'السلايدر', icon: '▧' }, { id: 'content', label: 'السياسات والمحتوى', icon: '☷' },
  { id: 'settings', label: 'الهوية والإعدادات', icon: '✧' }, { id: 'reviews', label: 'تقييمات العملاء', icon: '☆' }
];
const statuses = [['new','جديد'],['confirmed','تم التأكيد'],['preparing','قيد التجهيز'],['shipped','تم الشحن'],['completed','مكتمل'],['cancelled','ملغي']];
const money = (v: unknown) => Number(v || 0).toLocaleString('en-US', { maximumFractionDigits: 2 }) + ' ر.س';
const dateText = (v: unknown) => { const d = new Date(v as string); return v && !Number.isNaN(d.getTime()) ? d.toLocaleString('ar-SA') : '—'; };
function parseStorage(value: string) {
  const options: string[] = [], prices: Record<string, number> = {};
  value.split(/\r?\n/).map(x => x.trim()).filter(Boolean).forEach(line => {
    const [name, amount] = line.split('=').map(x => x.trim());
    if (name) { options.push(name); if (amount && Number.isFinite(Number(amount))) prices[name] = Number(amount); }
  });
  return { options, prices };
}
function parsePairs(value: string) {
  return Object.fromEntries(value.split(/\r?\n/).map(x => x.split('=').map(y => y.trim())).filter(x => x.length > 1 && x[0] && x[1]));
}

export default function AdminDashboard() {
  const [section, setSection] = useState<Section>('overview');
  const [data, setData] = useState<Row>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [query, setQuery] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [categoryName, setCategoryName] = useState('');
  const [categoryDescription, setCategoryDescription] = useState('');
  const [productId, setProductId] = useState('');
  const [product, setProduct] = useState({ name:'', categoryId:'', price:'', oldPrice:'', badge:'', shortDescription:'', details:'', colors:'', storage:'', images:'', colorImages:'' });
  const [bannerUrl, setBannerUrl] = useState('');
  const [bannerAlt, setBannerAlt] = useState('');
  const [settings, setSettings] = useState({ projectName:'', whatsappNumber:'', vatNumber:'', logoUrl:'', iconOneImageUrl:'', iconOneLinkUrl:'', iconTwoImageUrl:'', iconTwoLinkUrl:'' });
  const [pageKey, setPageKey] = useState('privacy');
  const [pageText, setPageText] = useState('');

  async function load(target: Section = section) {
    setLoading(true); setNotice('');
    try {
      const response = await fetch('/api/admin/data?section=' + target, { cache: 'no-store' });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'تعذر تحميل البيانات.');
      setData(result);
      if (target === 'settings' && result.settings) setSettings({
        projectName: result.settings.projectName || '', whatsappNumber: result.settings.whatsappNumber || '',
        vatNumber: result.settings.vatNumber || '', logoUrl: result.settings.logoUrl || '',
        iconOneImageUrl: result.settings.iconOneImageUrl || '', iconOneLinkUrl: result.settings.iconOneLinkUrl || '',
        iconTwoImageUrl: result.settings.iconTwoImageUrl || '', iconTwoLinkUrl: result.settings.iconTwoLinkUrl || ''
      });
      if (target === 'content' && result.items?.length) {
        const current = result.items.find((x: Row) => x.key === pageKey) || result.items[0];
        setPageText(current.content || ''); setPageKey(current.key);
      }
    } catch (e) { setNotice(e instanceof Error ? e.message : 'تعذر تحميل البيانات.'); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(section); }, [section]);

  async function mutate(method: 'POST'|'PATCH'|'DELETE', body?: Row, queryString = '') {
    setBusy(true); setNotice('');
    try {
      const response = await fetch('/api/admin/data' + queryString, {
        method, headers: body ? { 'content-type':'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'تعذر تنفيذ العملية.');
      setNotice('تم الحفظ بنجاح.'); await load(section); return true;
    } catch(e) { setNotice(e instanceof Error ? e.message : 'تعذر تنفيذ العملية.'); return false; }
    finally { setBusy(false); }
  }
  async function logout() {
    await fetch('/api/admin/auth', { method:'DELETE' });
    window.location.href = '/admin/login';
  }
  function saveCategory(e: FormEvent) {
    e.preventDefault();
    void mutate(categoryId ? 'PATCH':'POST', { section:'categories', id:categoryId, data:{ name:categoryName, description:categoryDescription } })
      .then(ok => { if(ok) { setCategoryId(''); setCategoryName(''); setCategoryDescription(''); } });
  }
  function startCategory(x: Row) { setCategoryId(x.id); setCategoryName(x.name); setCategoryDescription(x.description || ''); window.scrollTo({top:0,behavior:'smooth'}); }
  function moveCategory(index: number, delta: number) {
    const items = (data.items || []).filter((x: Row) => !x.deleted);
    const next = index + delta;
    if (next < 0 || next >= items.length) return;
    const [moved] = items.splice(index, 1); items.splice(next, 0, moved);
    void mutate('PATCH', { section:'categories', data:{ action:'reorder', ids:items.map((x: Row) => x.id) } });
  }
  function saveProduct(e: FormEvent) {
    e.preventDefault();
    const storage = parseStorage(product.storage);
    const body = {
      section:'products', id:productId,
      data:{
        name:product.name, categoryId:product.categoryId, price:Number(product.price), oldPrice:Number(product.oldPrice || 0),
        badge:product.badge, shortDescription:product.shortDescription, details:product.details,
        colors:product.colors.split(/[,،\n]/).map(x=>x.trim()).filter(Boolean),
        storageOptions:storage.options, storagePrices:storage.prices,
        ...((product.images.trim() || !productId) ? { images:product.images.split(/\r?\n/).map(x=>x.trim()).filter(Boolean) } : {}),
        ...((product.colorImages.trim() || !productId) ? { colorImages:parsePairs(product.colorImages) } : {})
      }
    };
    void mutate(productId ? 'PATCH':'POST', body).then(ok => { if(ok) { setProductId(''); setProduct({name:'',categoryId:'',price:'',oldPrice:'',badge:'',shortDescription:'',details:'',colors:'',storage:'',images:'',colorImages:''}); } });
  }
  function startProduct(x: Row) {
    const storage = (x.storageOptions || []).map((o: string)=> x.storagePrices?.[o] === undefined ? o : o+'='+x.storagePrices[o]).join('\n');
    const images = (x.images || []).filter((v: string)=>/^https:\/\//i.test(v) || v.startsWith('/api/')).join('\n');
    const colorImages = Object.entries(x.colorImages || {}).filter(([,v])=>typeof v==='string' && (/^https:\/\//i.test(v) || String(v).startsWith('/api/'))).map(([k,v])=>k+'='+String(v)).join('\n');
    setProductId(x.id); setProduct({ name:x.name || '', categoryId:x.categoryId || '', price:String(x.price ?? ''), oldPrice:x.oldPrice ? String(x.oldPrice):'', badge:x.badge || '', shortDescription:x.shortDescription || '', details:x.details || '', colors:(x.colors || []).join('، '), storage, images, colorImages });
    window.scrollTo({top:0,behavior:'smooth'});
  }
  const productItems = useMemo(()=> (data.items || []).filter((x: Row)=>!query || String(x.name).toLowerCase().includes(query.toLowerCase())),[data.items,query]);
  const orderItems = useMemo(()=> (data.items || []).filter((x: Row)=>!query || String(x.orderNumber).includes(query) || String(x.customer?.name).includes(query) || String(x.customer?.phone).includes(query)),[data.items,query]);

  return <div className={styles.adminApp}>
    <aside className={styles.sidebar}>
      <div className={styles.brand}><span className={styles.brandMark}>أ</span><span><strong>أرض الجوال</strong><small>لوحة الإدارة</small></span></div>
      <div className={styles.sidebarCaption}>إدارة المتجر</div>
      <nav className={styles.navigation}>{nav.map(x=><button key={x.id} className={section===x.id?styles.navActive:styles.navButton} onClick={()=>{setSection(x.id);setQuery('');}}><span>{x.icon}</span>{x.label}</button>)}</nav>
      <div className={styles.sidebarBottom}><a href="/" target="_blank" rel="noreferrer">فتح واجهة المتجر ↗</a><button onClick={logout}>تسجيل الخروج</button></div>
    </aside>
    <main className={styles.main}>
      <header className={styles.topbar}><div><span className={styles.kicker}>إدارة أرض الجوال</span><h1>{nav.find(x=>x.id===section)?.label}</h1></div><div className={styles.topActions}><span className={styles.liveDot}>لوحة الإدارة</span><button className={styles.refreshButton} onClick={()=>void load()}>↻ تحديث</button></div></header>
      {notice && <div className={styles.notice}>{notice}</div>}
      {loading ? <div className={styles.loading}>جارٍ تحميل البيانات...</div> : <>
        {section==='overview' && <section className={styles.pageSection}>
          <div className={styles.welcomePanel}><div><span>مرحبًا بك</span><h2>إدارة المتجر من مكان واحد</h2><p>أي تعديل تحفظه هنا يظهر في الموقع وبوت تيليجرام لأنهما يستخدمان قاعدة بيانات EE نفسها.</p></div><div className={styles.welcomeSymbol}>أ</div></div>
          <div className={styles.statsGrid}>{[['المنتجات',data.counts?.products,'▣'],['الأقسام',data.counts?.categories,'▦'],['كل الطلبات',data.counts?.orders,'▤'],['طلبات تحتاج متابعة',data.counts?.newOrders,'◷'],['صور السلايدر',data.counts?.banners,'▧'],['تقييمات ظاهرة',data.counts?.reviews,'☆']].map(([l,v,i])=><div className={styles.statCard} key={String(l)}><span>{i}</span><small>{l}</small><strong>{Number(v||0).toLocaleString('ar')}</strong></div>)}</div>
          <div className={styles.panel}><h3>اختصارات الإدارة</h3><div className={styles.quickGrid}>{nav.slice(1).map(x=><button key={x.id} onClick={()=>setSection(x.id)}><span>{x.icon}</span>{x.label}<b>←</b></button>)}</div></div>
          <div className={styles.infoPanel}><strong>قاعدة بيانات EE</strong><span>جاهزة للاتصال عبر MONGODB_URI. اسم القاعدة الافتراضي ee_store، ولا يتم الاتصال بقاعدة BB.</span></div>
        </section>}

        {section==='categories' && <section className={styles.pageSection}>
          <form className={styles.panel} onSubmit={saveCategory}><div className={styles.panelHeading}><h3>{categoryId?'تعديل القسم':'إضافة قسم'}</h3>{categoryId&&<button type="button" className={styles.textButton} onClick={()=>{setCategoryId('');setCategoryName('');setCategoryDescription('');}}>إلغاء</button>}</div>
            <div className={styles.formGrid}><label>اسم القسم<input required value={categoryName} onChange={e=>setCategoryName(e.target.value)}/></label><label>الوصف<input value={categoryDescription} onChange={e=>setCategoryDescription(e.target.value)}/></label></div><button className={styles.primaryButton} disabled={busy}>حفظ القسم</button>
          </form>
          <div className={styles.panel}><h3>الأقسام</h3><div className={styles.tableWrap}><table><thead><tr><th>القسم</th><th>الوصف</th><th>الحالة</th><th>ترتيب / تعديل</th></tr></thead><tbody>{(data.items||[]).filter((x:Row)=>!x.deleted).map((x:Row,index:number)=><tr key={x.id}><td>{x.name}</td><td>{x.description||'—'}</td><td>نشط</td><td><div className={styles.actions}><button onClick={()=>moveCategory(index,-1)} disabled={index===0}>↑</button><button onClick={()=>moveCategory(index,1)} disabled={index===(data.items||[]).filter((y:Row)=>!y.deleted).length-1}>↓</button><button onClick={()=>startCategory(x)}>تعديل</button><button className={styles.dangerText} onClick={()=>{if(window.confirm('حذف القسم؟ يجب أن يكون خاليًا من المنتجات.'))void mutate('DELETE',undefined,'?section=categories&id='+x.id);}}>حذف</button></div></td></tr>)}</tbody></table></div></div>
        </section>}

        {section==='products' && <section className={styles.pageSection}>
          <form className={styles.panel} onSubmit={saveProduct}><div className={styles.panelHeading}><h3>{productId?'تعديل المنتج':'إضافة منتج'}</h3>{productId&&<button type="button" className={styles.textButton} onClick={()=>setProductId('')}>إلغاء</button>}</div>
            <div className={styles.formGrid}>
              <label>اسم المنتج<input required value={product.name} onChange={e=>setProduct({...product,name:e.target.value})}/></label>
              <label>القسم<select required value={product.categoryId} onChange={e=>setProduct({...product,categoryId:e.target.value})}><option value="">اختر القسم</option>{(data.categories||[]).map((x:Row)=><option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
              <label>السعر<input required type="number" min="0" step="0.01" value={product.price} onChange={e=>setProduct({...product,price:e.target.value})}/></label>
              <label>السعر السابق<input type="number" min="0" step="0.01" value={product.oldPrice} onChange={e=>setProduct({...product,oldPrice:e.target.value})}/></label>
              <label>شارة المنتج<input value={product.badge} onChange={e=>setProduct({...product,badge:e.target.value})}/></label>
              <label>وصف مختصر<input value={product.shortDescription} onChange={e=>setProduct({...product,shortDescription:e.target.value})}/></label>
              <label className={styles.fullWidth}>الألوان (افصل بينها بفاصلة)<input value={product.colors} onChange={e=>setProduct({...product,colors:e.target.value})}/></label>
              <label className={styles.fullWidth}>التخزين والأسعار، كل سطر مثل 256GB=3500<textarea rows={3} value={product.storage} onChange={e=>setProduct({...product,storage:e.target.value})}/></label>
              <label className={styles.fullWidth}>تفاصيل المنتج<textarea rows={3} value={product.details} onChange={e=>setProduct({...product,details:e.target.value})}/></label>
              <label className={styles.fullWidth}>روابط الصور (HTTPS، كل رابط في سطر)<textarea rows={3} value={product.images} onChange={e=>setProduct({...product,images:e.target.value})}/></label>
              <label className={styles.fullWidth}>صور الألوان (كل سطر: اللون=رابط الصورة)<textarea rows={3} value={product.colorImages} onChange={e=>setProduct({...product,colorImages:e.target.value})}/></label>
            </div><button className={styles.primaryButton} disabled={busy}>حفظ المنتج</button>
          </form>
          <div className={styles.panel}><div className={styles.panelHeading}><h3>كتالوج المنتجات</h3><input className={styles.searchInput} placeholder="بحث باسم المنتج..." value={query} onChange={e=>setQuery(e.target.value)}/></div>
            <div className={styles.productList}>{productItems.map((x:Row)=><div className={styles.productRow} key={x.id}><div className={styles.productThumb}>{x.images?.[0]?<img src={String(x.images[0]).startsWith('http')?x.images[0]:'/api/products/'+x.id+'/image?index=0'} alt=""/>:'▣'}</div><div className={styles.productCopy}><strong>{x.name}</strong><small>{x.category} · {money(x.price)} · {(x.storageOptions||[]).join(' / ')||'بدون تخزين'}</small><small>{x.deleted?'محذوف':'نشط'}</small></div><div className={styles.actions}><button onClick={()=>startProduct(x)}>تعديل</button>{!x.deleted&&<button className={styles.dangerText} onClick={()=>{if(window.confirm('حذف المنتج من المتجر؟'))void mutate('DELETE',undefined,'?section=products&id='+x.id);}}>حذف</button>}</div></div>)}</div>
          </div>
        </section>}

        {section==='orders' && <section className={styles.panel}><div className={styles.panelHeading}><h3>طلبات المتجر</h3><input className={styles.searchInput} value={query} onChange={e=>setQuery(e.target.value)} placeholder="رقم الطلب أو اسم العميل أو الهاتف"/></div><div className={styles.ordersGrid}>{orderItems.map((x:Row)=><article className={styles.orderCard} key={x.id}>
          <div className={styles.orderTop}><strong>طلب {x.orderNumber||x.id.slice(-6)}</strong><span>{dateText(x.createdAt)}</span></div>
          <div className={styles.orderCustomer}><strong>{x.customer?.name||'عميل'}</strong><span>{x.customer?.phone||'—'}</span><small>{x.customer?.address||'—'}</small></div>
          <div className={styles.orderItems}>{(x.items||[]).map((line:Row,i:number)=><span key={i}>{line.name} × {line.quantity||1}{line.color?' · '+line.color:''}{line.storage?' · '+line.storage:''}</span>)}</div>
          <div className={styles.orderBottom}><strong>{money(x.total)}</strong><span>{x.paymentStatus==='paid'?'مدفوع':x.paymentStatus==='failed'?'فشل الدفع':'بانتظار الدفع'}</span></div>
          <label className={styles.statusField}>الحالة<select value={x.status} onChange={e=>void mutate('PATCH',{section:'orders',id:x.id,data:{status:e.target.value}})}>{statuses.map(([v,l])=><option key={v} value={v}>{l}</option>)}</select></label>
        </article>)}</div></section>}

        {section==='banners' && <section className={styles.pageSection}>
          <form className={styles.panel} onSubmit={e=>{e.preventDefault();void mutate('POST',{section:'banners',data:{imageUrl:bannerUrl,alt:bannerAlt}}).then(ok=>{if(ok){setBannerUrl('');setBannerAlt('');}});}}><h3>إضافة صورة للسلايدر</h3><div className={styles.formGrid}><label className={styles.fullWidth}>رابط الصورة HTTPS<input required type="url" value={bannerUrl} onChange={e=>setBannerUrl(e.target.value)}/></label><label className={styles.fullWidth}>وصف الصورة<input value={bannerAlt} onChange={e=>setBannerAlt(e.target.value)}/></label></div><button className={styles.primaryButton} disabled={busy}>إضافة الصورة</button></form>
          <div className={styles.bannerGrid}>{(data.items||[]).map((x:Row)=><article className={styles.bannerCard} key={x.id}>{x.imageUrl?<img src={x.imageUrl} alt={x.alt||''}/>:<div className={styles.noImage}>لا توجد معاينة</div>}<div><strong>{x.alt||'صورة سلايدر'}</strong><button className={styles.dangerText} onClick={()=>{if(window.confirm('حذف الصورة من السلايدر؟'))void mutate('DELETE',undefined,'?section=banners&id='+x.id);}}>حذف</button></div></article>)}</div>
        </section>}

        {section==='settings' && <form className={styles.panel} onSubmit={e=>{e.preventDefault();void mutate('PATCH',{section:'settings',data:settings});}}><h3>الهوية البصرية وبيانات المتجر</h3><p className={styles.muted}>يتم حفظ هذه الإعدادات في نفس سجلات المتجر التي يقرأها الموقع وبوت تيليجرام.</p><div className={styles.formGrid}>
          <label>اسم المتجر<input required value={settings.projectName} onChange={e=>setSettings({...settings,projectName:e.target.value})}/></label>
          <label>رقم واتساب الدعم<input value={settings.whatsappNumber} onChange={e=>setSettings({...settings,whatsappNumber:e.target.value})}/></label>
          <label>الرقم الضريبي<input value={settings.vatNumber} onChange={e=>setSettings({...settings,vatNumber:e.target.value})}/></label>
          <label className={styles.fullWidth}>رابط الشعار HTTPS<input type="url" placeholder="https://..." value={settings.logoUrl} onChange={e=>setSettings({...settings,logoUrl:e.target.value})}/></label>
          <label>صورة أيقونة الفوتر الأولى<input type="url" value={settings.iconOneImageUrl} onChange={e=>setSettings({...settings,iconOneImageUrl:e.target.value})}/></label>
          <label>رابط الأيقونة الأولى<input type="url" value={settings.iconOneLinkUrl} onChange={e=>setSettings({...settings,iconOneLinkUrl:e.target.value})}/></label>
          <label>صورة أيقونة الفوتر الثانية<input type="url" value={settings.iconTwoImageUrl} onChange={e=>setSettings({...settings,iconTwoImageUrl:e.target.value})}/></label>
          <label>رابط الأيقونة الثانية<input type="url" value={settings.iconTwoLinkUrl} onChange={e=>setSettings({...settings,iconTwoLinkUrl:e.target.value})}/></label>
        </div>{data.settings?.logoFileConfigured&&<div className={styles.infoPanel}>يوجد شعار مرفوع من تيليجرام. يمكنك استبداله برابط شعار هنا.</div>}<button className={styles.primaryButton} disabled={busy}>حفظ الهوية والإعدادات</button></form>}

        {section==='content' && <section className={styles.panel}><h3>السياسات وخدمات العملاء</h3><p className={styles.muted}>أي تعديل هنا يظهر في صفحات الموقع ويُقرأ من نفس السجلات المستخدمة في تيليجرام.</p><label className={styles.pagePicker}>الصفحة<select value={pageKey} onChange={e=>{setPageKey(e.target.value);setPageText((data.items||[]).find((x:Row)=>x.key===e.target.value)?.content||'');}}>{(data.items||[]).map((x:Row)=><option key={x.key} value={x.key}>{x.title}</option>)}</select></label><textarea className={styles.contentEditor} rows={16} value={pageText} onChange={e=>setPageText(e.target.value)}/><div className={styles.editorFooter}><span>حتى 3500 حرف</span><button className={styles.primaryButton} disabled={busy||!pageText.trim()} onClick={()=>void mutate('PATCH',{section:'content',data:{key:pageKey,content:pageText}})}>حفظ ونشر النص</button></div></section>}

        {section==='reviews' && <section className={styles.panel}><h3>تقييمات العملاء</h3><div className={styles.reviewList}>{(data.items||[]).map((x:Row)=><article className={styles.reviewRow} key={x.id}><div><strong>{x.name||'عميل'}</strong><p>{x.comment}</p><small>{'★'.repeat(Math.max(0,Math.min(5,x.rating||0)))} · {x.isDemo?'تقييم تجريبي':'تقييم عميل'}</small></div><div className={styles.actions}><button onClick={()=>void mutate('PATCH',{section:'reviews',id:x.id,data:{visible:!x.visible}})}>{x.visible?'إخفاء':'إظهار'}</button><button className={styles.dangerText} onClick={()=>{if(window.confirm('حذف التقييم نهائيًا؟'))void mutate('DELETE',undefined,'?section=reviews&id='+x.id);}}>حذف</button></div></article>)}</div></section>}
      </>}
    </main>
  </div>;
}
