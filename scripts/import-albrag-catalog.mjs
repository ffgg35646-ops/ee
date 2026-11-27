#!/usr/bin/env node
import { MongoClient, ObjectId } from 'mongodb';
import { isIP } from 'node:net';

const DB_NAME = 'ee_store';
const HOSTS = new Set(['al-brag-ksa.com','www.al-brag-ksa.com','al-brag-ksa.store','www.al-brag-ksa.store']);
const ORIGINS = ['https://www.al-brag-ksa.com','https://al-brag-ksa.com','https://www.al-brag-ksa.store','https://al-brag-ksa.store'];
const USER_AGENT = 'Mozilla/5.0 (compatible; EE-Catalog-Importer/1.0)';
const MAX_PRODUCTS = 2500;
const MAX_HTML_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_IMAGES = 10;
const BATCH_SIZE = 3;

function decode(value='') {
  return String(value).replace(/&nbsp;/gi,' ').replace(/&amp;/gi,'&').replace(/&quot;/gi,'"')
    .replace(/&#39;|&apos;/gi,"'").replace(/&lt;/gi,'<').replace(/&gt;/gi,'>')
    .replace(/&#(\d+);/g,(_,n)=>{const p=Number(n);return p>=0&&p<=0x10ffff?String.fromCodePoint(p):'';})
    .replace(/&#x([\da-f]+);/gi,(_,n)=>{const p=parseInt(n,16);return p>=0&&p<=0x10ffff?String.fromCodePoint(p):'';});
}
function strip(value='') {
  return decode(String(value).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,' ').replace(/<br\s*\/?>/gi,'\n')
    .replace(/<\/(?:p|div|li|tr|h[1-6])\s*>/gi,'\n').replace(/<[^>]+>/g,' '))
    .replace(/[\t\r ]+/g,' ').replace(/\n[ \t]+/g,'\n').replace(/\n{3,}/g,'\n\n').trim();
}
function attr(tag,name) {
  const escaped=name.replace(/[.*+?^\${}()|[\]\\]/g,'\\$&');
  const m=tag.match(new RegExp("\\b"+escaped+"\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s>]+))","i"));
  return decode(m?.[1]??m?.[2]??m?.[3]??'').trim();
}
function meta(html,key) {
  for(const tag of html.match(/<meta\b[^>]*>/gi)||[]) {
    const name=attr(tag,'property')||attr(tag,'name')||attr(tag,'itemprop');
    if(name.toLowerCase()===key.toLowerCase()) { const value=attr(tag,'content'); if(value)return value; }
  }
  return '';
}
function tagText(html,name) {
  const m=html.match(new RegExp('<'+name+'\\b[^>]*>([\\s\\S]*?)<\\/'+name+'>','i'));
  return strip(m?.[1]||'');
}
function amount(value) {
  if(typeof value==='number'&&Number.isFinite(value)&&value>0)return value;
  if(typeof value!=='string')return undefined;
  const n=Number(value.replace(/[٠-٩]/g,d=>String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .replace(/[۰-۹]/g,d=>String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d))).replace(/[٬,\s]/g,'').replace(/[^\d.]/g,''));
  return Number.isFinite(n)&&n>0?n:undefined;
}
function addUnique(list,value,limit=40) {
  const v=String(value||'').trim().replace(/\s+/g,' ');
  if(v&&!list.some(x=>x.toLowerCase()===v.toLowerCase())&&list.length<limit)list.push(v);
}
function walk(value,out=[],seen=new Set()) {
  if(!value||typeof value!=='object'||seen.has(value))return out;
  seen.add(value);if(!Array.isArray(value))out.push(value);
  for(const child of Array.isArray(value)?value:Object.values(value))walk(child,out,seen);
  return out;
}
function types(value) { return (Array.isArray(value)?value:[value]).filter(x=>typeof x==='string').map(x=>x.toLowerCase().split('/').pop()); }
function first(...values) { for(const v of values)if(typeof v==='string'&&v.trim())return strip(v).slice(0,5000);return ''; }
function pairs(value) {
  const items=Array.isArray(value)?value:value?[value]:[];
  return items.flatMap(x=>{if(!x||typeof x!=='object')return[];const k=first(x.name,x.propertyID),v=first(x.value,x.valueReference?.name,x.valueReference);return k&&v?[[k,v]]:[];});
}
function offerPrice(input) {
  for(const o of (Array.isArray(input)?input:input?[input]:[])) {
    const p=amount(o?.price??o?.lowPrice);if(p)return p;
    for(const s of (Array.isArray(o?.priceSpecification)?o.priceSpecification:o?.priceSpecification?[o.priceSpecification]:[])){const n=amount(s?.price);if(n)return n;}
  }
  return undefined;
}
function priceFromMarkup(html) {
  for(const tag of html.match(/<([a-z0-9]+)\b[^>]*(?:itemprop=["']price["']|class=["'][^"']*price[^"']*["'])[^>]*>/gi)||[]) {
    const direct=amount(attr(tag,'content')||attr(tag,'data-price')||attr(tag,'value'));if(direct)return direct;
    const name=tag.match(/^<([a-z0-9]+)/i)?.[1];if(!name)continue;
    const start=html.indexOf(tag)+tag.length, end=html.toLowerCase().indexOf('</'+name.toLowerCase()+'>',start);
    if(end>=start){const n=amount(strip(html.slice(start,end)));if(n)return n;}
  }
  return undefined;
}
function safeSourceUrl(value) {
  const u=new URL(value);
  if(u.protocol!=='https:'||!HOSTS.has(u.hostname.toLowerCase())||u.username||u.password)throw new Error('Source URL is not an approved Al-Brag host');
  return u;
}
async function getText(url,maxBytes=MAX_HTML_BYTES) {
  let u=safeSourceUrl(url);
  for(let attempt=0;attempt<5;attempt++){
    const r=await fetch(u,{redirect:'manual',cache:'no-store',headers:{accept:'text/html,application/xhtml+xml,application/xml,text/plain,*/*;q=0.8','accept-language':'ar-SA,ar;q=0.9,en;q=0.7','user-agent':USER_AGENT},signal:AbortSignal.timeout(25000)});
    if([301,302,303,307,308].includes(r.status)){const loc=r.headers.get('location');if(!loc||attempt===4)throw new Error('Too many redirects');u=safeSourceUrl(new URL(loc,u).toString());continue;}
    if(!r.ok)throw new Error('HTTP '+r.status+' for '+u);
    const len=Number(r.headers.get('content-length')||0);if(len>maxBytes)throw new Error('Response exceeds size limit');
    const b=Buffer.from(await r.arrayBuffer());if(b.length>maxBytes)throw new Error('Response exceeds size limit');
    return {url:u,html:b.toString('utf8')};
  }
  throw new Error('Could not fetch source page');
}
function productUrl(value,base) {
  try{const u=new URL(value,base);if(u.protocol!=='https:'||!HOSTS.has(u.hostname.toLowerCase())||!/^\/product2\/\d+\/?$/i.test(u.pathname)||u.username||u.password)return '';
    u.hash='';u.search='';u.pathname=u.pathname.replace(/\/+$/,'');return u.toString();}catch{return '';}
}
function collectLinks(html,base) {
  const found=new Set();
  for(const m of html.matchAll(/<loc\b[^>]*>([\s\S]*?)<\/loc>/gi)){const u=productUrl(strip(m[1]),base);if(u)found.add(u);}
  for(const a of html.match(/<a\b[^>]*>/gi)||[]){const u=productUrl(attr(a,'href'),base);if(u)found.add(u);}
  for(const m of html.matchAll(/https?:\/\/(?:www\.)?al-brag-ksa\.(?:com|store)\/product2\/\d+\/?/gi)){const u=productUrl(m[0],base);if(u)found.add(u);}
  for(const m of html.matchAll(/\/product2\/\d+\/?/gi)){const u=productUrl(m[0],base);if(u)found.add(u);}
  return [...found];
}
function collectCatalogs(html,base) {
  const found=new Set();
  for(const a of html.match(/<a\b[^>]*>/gi)||[]){try{const u=new URL(attr(a,'href'),base);if(u.protocol==='https:'&&HOSTS.has(u.hostname.toLowerCase())&&u.pathname.replace(/\/+$/,'')==='/catalog'&&u.searchParams.has('category')){u.hash='';found.add(u.toString());}}catch{}}
  return [...found];
}
async function discover() {
  let origin='';const warnings=[];
  for(const candidate of ORIGINS){try{const p=await getText(candidate+'/robots.txt');origin=p.url.origin;break;}catch(e){warnings.push(candidate+' '+e.message);}}
  if(!origin){for(const candidate of ORIGINS){try{const p=await getText(candidate+'/');origin=p.url.origin;break;}catch(e){warnings.push(candidate+' '+e.message);}}}
  if(!origin)throw new Error('Al-Brag source could not be reached. '+warnings.slice(0,4).join(' | '));
  const productUrls=new Set(), sitemapQueue=new Set([origin+'/sitemap.xml',origin+'/sitemap_index.xml',origin+'/sitemap-index.xml',origin+'/sitemap_products.xml',origin+'/product-sitemap.xml']), visited=new Set();
  try{const robots=await getText(origin+'/robots.txt');for(const line of robots.html.split(/\r?\n/)){const m=line.match(/^\s*sitemap:\s*(\S+)/i);if(m){try{sitemapQueue.add(safeSourceUrl(m[1]).toString());}catch{}}}}catch(e){warnings.push('robots.txt '+e.message);}
  while(sitemapQueue.size&&visited.size<40&&productUrls.size<MAX_PRODUCTS){
    const url=sitemapQueue.values().next().value;sitemapQueue.delete(url);if(visited.has(url))continue;visited.add(url);
    try{const p=await getText(url);for(const x of collectLinks(p.html,p.url))productUrls.add(x);
      for(const m of p.html.matchAll(/<loc\b[^>]*>([\s\S]*?)<\/loc>/gi)){try{const child=safeSourceUrl(strip(m[1]));if(/\.xml(?:\.gz)?(?:$|\?)/i.test(child.pathname)&&!visited.has(child.toString()))sitemapQueue.add(child.toString());}catch{}}
    }catch(e){warnings.push(new URL(url).pathname+' '+e.message);}
  }
  const home=await getText(origin+'/');for(const x of collectLinks(home.html,home.url))productUrls.add(x);
  const queue=collectCatalogs(home.html,home.url).slice(0,160),seen=new Set();
  while(queue.length&&productUrls.size<MAX_PRODUCTS){
    const url=queue.shift();if(seen.has(url))continue;seen.add(url);
    try{const p=await getText(url);for(const x of collectLinks(p.html,p.url))productUrls.add(x);
      for(const next of collectCatalogs(p.html,p.url))if(!seen.has(next)&&queue.length+seen.size<180)queue.push(next);
      for(const a of p.html.match(/<a\b[^>]*>/gi)||[]){try{const n=new URL(attr(a,'href'),p.url);if(n.pathname==='/catalog'&&n.searchParams.get('category')===p.url.searchParams.get('category')&&['page','p','paged','pageNumber','page_number'].some(k=>n.searchParams.has(k))&&!seen.has(n.toString())&&queue.length+seen.size<180)queue.push(n.toString());}catch{}}
    }catch(e){warnings.push(url+' '+e.message);}
  }
  if(!productUrls.size)throw new Error('No /product2/{id} links were discovered. '+warnings.slice(-5).join(' | '));
  return {origin,urls:[...productUrls].slice(0,MAX_PRODUCTS).sort((a,b)=>Number(a.match(/\/product2\/(\d+)/)?.[1]||0)-Number(b.match(/\/product2\/(\d+)/)?.[1]||0)),warnings};
}
function resolveImage(value,base) {
  try{const u=new URL(typeof value==='string'?value:value?.url,base);return ['https:','http:'].includes(u.protocol)&&!u.username&&!u.password?u.toString():'';}catch{return '';}
}
async function parseProduct(url) {
  const page=await getText(url),html=page.html,nodes=[];
  for(const m of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)){try{nodes.push(...walk(JSON.parse(m[1])));}catch{}}
  const product=nodes.find(n=>types(n['@type']).some(t=>t==='product'||t==='productgroup'));
  const variants=Array.isArray(product?.hasVariant)?product.hasVariant.filter(x=>x&&typeof x==='object'):[];
  const variantOffers=variants.flatMap(v=>Array.isArray(v.offers)?v.offers:v.offers?[v.offers]:[]);
  const name=first(product?.name,meta(html,'og:title'),meta(html,'twitter:title'),tagText(html,'h1'),tagText(html,'title'));
  const description=first(product?.description,meta(html,'description'),meta(html,'og:description'),meta(html,'twitter:description'));
  const price=offerPrice(product?.offers)||offerPrice(variantOffers)||amount(meta(html,'product:price:amount'))||amount(meta(html,'og:price:amount'))||priceFromMarkup(html);
  const oldPrice=amount(meta(html,'product:price:standard_amount'))||amount(meta(html,'product:price:original_amount'))||amount(meta(html,'product:price:old_amount'));
  if(!name||!price)throw new Error(!name?'Product title missing':'Reliable numeric price missing');
  const images=[],imgTags=html.match(/<(?:img|source)\b[^>]*>/gi)||[];
  const candidates=imgTags.flatMap(tag=>{
    const context=(attr(tag,'class')+' '+attr(tag,'id')+' '+attr(tag,'alt')).toLowerCase();
    if(!/product|gallery|zoom|detail|main-image|swiper|thumbnail|thumb|صورة المنتج/.test(context)&&!/\/(?:products?|product-images?)\//i.test(attr(tag,'src')+attr(tag,'data-src')))return[];
    return [attr(tag,'data-large_image'),attr(tag,'data-zoom-image'),attr(tag,'data-src'),attr(tag,'data-original'),attr(tag,'srcset').split(',')[0]?.trim().split(/\s+/)[0],attr(tag,'src')].filter(Boolean);
  });
  const structured=Array.isArray(product?.image)?product.image:product?.image?[product.image]:[];
  for(const raw of [...structured,meta(html,'og:image'),meta(html,'twitter:image'),...candidates]){const value=resolveImage(raw,page.url);if(value)addUnique(images,value,MAX_IMAGES);}
  if(!images.length)throw new Error('Product page did not expose image URLs');
  const colors=[],storageOptions=[],storagePrices={},specifications=[];
  for(const [k,v] of pairs(product?.additionalProperty)){
    if(/color|colour|لون/i.test(k))addUnique(colors,v,30);
    if(/storage|capacity|memory|سعة|تخزين|مساحة/i.test(k)||/\b(?:\d{2,4}\s?(?:gb|tb)|\d(?:\.\d)?\s?tb)\b/i.test(v))addUnique(storageOptions,v,30);
    addUnique(specifications,k+': '+v,40);
  }
  if(typeof product?.color==='string')addUnique(colors,product.color,30);
  for(const variant of variants){
    const ps=pairs(variant.additionalProperty),color=first(variant.color,...ps.filter(([k])=>/color|colour|لون/i.test(k)).map(([,v])=>v)),storage=first(variant.size,...ps.filter(([k])=>/storage|capacity|memory|سعة|تخزين|مساحة/i.test(k)).map(([,v])=>v));
    if(color)addUnique(colors,color,30);if(storage){addUnique(storageOptions,storage,30);const p=offerPrice(variant.offers);if(p&&!storagePrices[storage])storagePrices[storage]=p;}
  }
  for(const row of html.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi)||[]){
    const cells=[...row.matchAll(/<(?:th|td)\b[^>]*>([\s\S]*?)<\/(?:th|td)>/gi)].map(m=>strip(m[1]));
    if(cells.length>=2&&cells[0]&&cells[1])addUnique(specifications,cells[0]+': '+cells.slice(1).join('، '),40);
  }
  const crumb=nodes.find(n=>types(n['@type']).includes('breadcrumblist')),crumbs=Array.isArray(crumb?.itemListElement)?crumb.itemListElement:[];
  const category=first(product?.category,crumbs.length>1?crumbs[crumbs.length-2]?.name:'',meta(html,'article:section'))||'منتجات مستوردة';
  const brand=first(product?.brand?.name,product?.brand),sku=first(product?.sku,product?.mpn),barcode=first(product?.gtin13,product?.gtin12,product?.gtin14,product?.gtin);
  if(brand)addUnique(specifications,'الماركة: '+brand,40);if(sku)addUnique(specifications,'رمز المنتج: '+sku,40);if(barcode)addUnique(specifications,'الباركود: '+barcode,40);
  const details=[description,specifications.length?'مواصفات المنتج:\n'+specifications.join('\n'):''].filter(Boolean).join('\n\n').slice(0,3000)||name;
  return {sourceProductUrl:page.url.toString().replace(/[?#].*$/,'').replace(/\/+$/,''),sourceStore:page.url.hostname.toLowerCase().replace(/^www\./,''),name:name.slice(0,120),price,...(oldPrice&&oldPrice>price?{oldPrice}:{}),shortDescription:(description||name).slice(0,300),details,specifications,images,colors,storageOptions,storagePrices,sourceCategory:category.slice(0,120),...(brand?{sourceBrand:brand.slice(0,120)}:{}),...(sku?{sourceSku:sku.slice(0,100)}:{}),...(barcode?{sourceBarcode:barcode.slice(0,80)}:{})};
}
function privateHost(host) {
  const h=host.toLowerCase().replace(/^\[|\]$/g,'');
  if(h==='localhost'||h.endsWith('.localhost')||h.endsWith('.local')||h.endsWith('.internal'))return true;
  const v=isIP(h);
  if(v===4){const [a,b]=h.split('.').map(Number);return a===0||a===10||a===127||a>=224||(a===169&&b===254)||(a===172&&b>=16&&b<=31)||(a===192&&b===168);}
  if(v===6)return h==='::'||h==='::1'||h.startsWith('fc')||h.startsWith('fd')||h.startsWith('fe8')||h.startsWith('fe9')||h.startsWith('fea')||h.startsWith('feb');
  return false;
}
async function saveImage(db,product,urlValue,index) {
  try {
    const url=new URL(urlValue);if(!['https:','http:'].includes(url.protocol)||url.username||url.password||privateHost(url.hostname))throw new Error('Invalid image URL');
    const r=await fetch(url,{redirect:'follow',headers:{accept:'image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8','user-agent':USER_AGENT},signal:AbortSignal.timeout(20000)});
    if(!r.ok)throw new Error('HTTP '+r.status);
    const type=(r.headers.get('content-type')||'').split(';')[0].trim().toLowerCase();if(!/^image\/(jpeg|png|webp|gif|bmp|avif)$/.test(type))throw new Error('Not an image');
    if(Number(r.headers.get('content-length')||0)>MAX_IMAGE_BYTES)throw new Error('Image too large');
    const bytes=Buffer.from(await r.arrayBuffer());if(!bytes.length||bytes.length>MAX_IMAGE_BYTES)throw new Error('Image empty or too large');
    const id=new ObjectId();await db.collection('admin_media').insertOne({_id:id,dataBase64:bytes.toString('base64'),contentType:type,filename:'al-brag-'+id.toHexString()+'-'+(index+1),size:bytes.length,sourceProductUrl:product.sourceProductUrl,sourceImageUrl:urlValue,sourceProductImageIndex:index,createdAt:new Date(),createdByAdminEmail:'source-catalog-import'});
    return 'admin-media:'+id.toHexString();
  } catch(e) { console.warn('Image kept as source URL:',urlValue,e.message);return urlValue; }
}
async function categoryFor(db,name,cache) {
  const key=(name||'منتجات مستوردة').trim().replace(/\s+/g,' ').slice(0,120)||'منتجات مستوردة';
  if(cache.has(key))return cache.get(key);
  const c=db.collection('categories');let item=await c.findOne({name:key,deleted:{$ne:true}});
  if(!item){const old=await c.findOne({name:key}),now=new Date();if(old){await c.updateOne({_id:old._id},{$set:{deleted:false,updatedAt:now}});item={...old,deleted:false,updatedAt:now};}else{item={_id:new ObjectId(),name:key,description:'قسم مستورد من موقع البرق المضيء',createdAt:now,updatedAt:now,deleted:false};await c.insertOne(item);}}
  cache.set(key,item);return item;
}
async function saveProduct(db,raw,cache) {
  const c=db.collection('products'),existing=await c.findOne({sourceProductUrl:raw.sourceProductUrl},{projection:{_id:1}});
  if(existing)return 'skipped';
  const category=await categoryFor(db,raw.sourceCategory,cache),images=[];
  for(const [i,url] of raw.images.entries())images.push(await saveImage(db,raw,url,i));
  const now=new Date(),doc={_id:new ObjectId(),categoryId:category._id.toHexString(),category:category.name,name:raw.name,price:raw.price,...(raw.oldPrice?{oldPrice:raw.oldPrice}:{}),shortDescription:raw.shortDescription,details:raw.details,specifications:raw.specifications,colors:raw.colors,storageOptions:raw.storageOptions,...(Object.keys(raw.storagePrices).length?{storagePrices:raw.storagePrices}:{}),images,sourceImageUrls:raw.images,sourceStore:raw.sourceStore,sourceProductUrl:raw.sourceProductUrl,...(raw.sourceBrand?{sourceBrand:raw.sourceBrand}:{}),...(raw.sourceSku?{sourceSku:raw.sourceSku}:{}),...(raw.sourceBarcode?{sourceBarcode:raw.sourceBarcode}:{}),sourceImportedAt:now,createdByAdminEmail:'source-catalog-import',createdAt:now,updatedAt:now};
  try{await c.insertOne(doc);return 'imported';}catch(e){await db.collection('admin_media').deleteMany({sourceProductUrl:raw.sourceProductUrl});if(e.code===11000)return 'skipped';throw e;}
}
async function main() {
  const uri=process.env.MONGODB_URI;if(!uri)throw new Error('MONGODB_URI missing. Use --env-file=.env.local or set it in the shell.');
  if(process.env.MONGODB_DB&&process.env.MONGODB_DB!==DB_NAME)throw new Error('MONGODB_DB must be ee_store; refusing another database.');
  const client=new MongoClient(uri);await client.connect();
  try{
    const db=client.db(DB_NAME),before=await db.collection('products').countDocuments({});
    await db.collection('products').createIndex({sourceProductUrl:1},{unique:true,sparse:true});
    console.log('Connected directly to ee_store. Existing products:',before);
    const found=await discover();console.log('Source:',found.origin,'| discovered product URLs:',found.urls.length);
    for(const w of found.warnings.slice(0,8))console.warn('Discovery:',w);
    const cache=new Map();let imported=0,skipped=0,failed=0;const errors=[];
    for(let offset=0;offset<found.urls.length;offset+=BATCH_SIZE){
      const batch=found.urls.slice(offset,offset+BATCH_SIZE);
      const parsed=await Promise.all(batch.map(async url=>{try{return{url,data:await parseProduct(url)};}catch(e){return{url,error:e.message};}}));
      for(const item of parsed){
        if(!item.data){failed++;errors.push(item.url+': '+item.error);continue;}
        try{const state=await saveProduct(db,item.data,cache);if(state==='imported')imported++;else skipped++;}
        catch(e){failed++;errors.push(item.url+': '+e.message);}
      }
      console.log('Progress',Math.min(offset+BATCH_SIZE,found.urls.length)+'/'+found.urls.length,'imported',imported,'existing',skipped,'failed',failed);
    }
    const after=await db.collection('products').countDocuments({}),active=await db.collection('products').countDocuments({deleted:{$ne:true}});
    const categories=await db.collection('categories').countDocuments({deleted:{$ne:true}}),media=await db.collection('admin_media').countDocuments({sourceProductUrl:{$exists:true}});
    console.log('\nRESULT',JSON.stringify({database:DB_NAME,source:found.origin,discovered:found.urls.length,imported,skipped,failed,productsBefore:before,productsAfter:after,activeProducts:active,activeCategories:categories,sourceImageMediaFiles:media,errors:errors.slice(0,30)},null,2));
  }finally{await client.close();}
}
main().catch(e=>{console.error('\nIMPORT FAILED:',e.stack||e.message);process.exitCode=1;});
