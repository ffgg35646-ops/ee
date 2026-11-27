'use client';

import { useCallback, useEffect, useMemo, useState, type ButtonHTMLAttributes, type FormEvent, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from 'react';
import { useRouter } from 'next/navigation';
import styles from '@/app/admin/admin.module.css';

type AdminUser = { id: string; email: string; name: string; role: 'super_admin' | 'admin'; active?: boolean };
type AnyRow = Record<string, unknown>;
type ProductRow = AnyRow & {
  id: string; name: string; category: string; categoryId: string; price: number;
  oldPrice?: number; details: string; shortDescription?: string; colors?: string[]; colorImages?: Record<string, string>;
  storageOptions?: string[]; storagePrices?: Record<string, number>; specifications?: string[];
  images?: string[]; sourceProductUrl?: string; sourceBrand?: string; sourceSku?: string;
};
type CategoryRow = AnyRow & { id: string; name: string; description?: string; productCount?: number; displayOrder?: number };
type OrderRow = AnyRow & {
  id: string; orderNumber?: string; status: string; total: number;
  customer?: { name?: string; phone?: string; email?: string; address?: string };
  items?: Array<{ name?: string; quantity?: number; color?: string; storage?: string }>;
  customerNotificationKey?: string; cancellationReason?: string;
};
type ImportJob = {
  status: string; urls: string[]; cursor: number; imported: number; skipped: number; failed: number;
  errors?: string[]; scannedSitemaps?: number; scannedPages?: number; warnings?: string[];
  startedBy?: string; lastBatch?: Array<{ state: string; name: string; error?: string }>;
};
type ReviewRow = AnyRow & { id: string; name?: string; comment?: string; rating?: number; visible?: boolean; createdAt?: string; orderNumber?: string };
type BannerRow = { id: string; imageUrl: string; alt: string };
type StorePage = { key: string; title: string; group: string; content: string };
type StoreData = {
  settings: Record<string, AnyRow>;
  pages: StorePage[];
  banners: BannerRow[];
};
type ViewKey = 'dashboard' | 'products' | 'categories' | 'orders' | 'import' | 'store' | 'reviews' | 'admins' | 'security';

const NAV: Array<{ id: ViewKey; label: string; icon: string }> = [
  { id: 'dashboard', label: 'الرئيسية', icon: '⌂' },
  { id: 'products', label: 'المنتجات', icon: '▦' },
  { id: 'categories', label: 'الأقسام', icon: '▤' },
  { id: 'orders', label: 'طلبات العملاء', icon: '▣' },
  { id: 'import', label: 'استيراد المنتجات', icon: '⇩' },
  { id: 'store', label: 'إعدادات المتجر', icon: '⚙' },
  { id: 'reviews', label: 'تقييمات العملاء', icon: '☆' },
  { id: 'admins', label: 'المديرون', icon: '♙' },
  { id: 'security', label: 'الأمان وكلمة المرور', icon: '⌑' }
];

const PAGE_OPTIONS = [
  ['privacy', 'سياسة الخصوصية'], ['terms', 'الشروط والأحكام'], ['returns', 'الاستبدال والاسترجاع'],
  ['warranty', 'سياسة الضمان'], ['shipping', 'الشحن والتوصيل'], ['payment-methods', 'طرق الدفع'],
  ['ordering', 'طلب الدفع والشراء'], ['faq', 'الأسئلة الشائعة']
] as const;

const ORDER_STATUS_LABELS: Record<string, string> = {
  new: 'جديد', confirmed: 'تم التأكيد', preparing: 'قيد التجهيز', shipped: 'تم الشحن',
  completed: 'مكتمل', cancelled: 'ملغي'
};

function cn(...parts: Array<string | false | undefined>) {
  return parts.filter(Boolean).join(' ');
}

function money(value: unknown) {
  const amount = Number(value || 0);
  return (Number.isFinite(amount) ? amount : 0).toLocaleString('en-US', { maximumFractionDigits: 2 }) + ' ر.س';
}

function formatDate(value: unknown) {
  if (!value) return '—';
  const date = new Date(String(value));
  return Number.isFinite(date.getTime()) ? date.toLocaleString('ar-SA', { dateStyle: 'medium', timeStyle: 'short' }) : '—';
}

function lines(value: unknown) {
  return Array.isArray(value) ? value.map(String).join('\n') : '';
}

function parseLines(value: string) {
  return [...new Set(value.split(/[\r\n,،;؛]+/).map((item) => item.trim()).filter(Boolean))];
}

function parseStoragePrices(value: string) {
  const result: Record<string, number> = {};
  for (const entry of value.split(/[\r\n,،;؛]+/)) {
    const match = entry.trim().match(/^(.+?)\s*=\s*(\d+(?:\.\d+)?)$/);
    if (match) result[match[1].trim()] = Number(match[2]);
  }
  return result;
}


async function uploadAdminMedia(files: File[]) {
  if (!files.length) return [] as Array<{ id: string; ref: string }>;
  const form = new FormData();
  for (const file of files) form.append('files', file);
  const response = await fetch('/api/admin/media', { method: 'POST', credentials: 'same-origin', body: form });
  const data = await response.json() as { files?: Array<{ id: string; ref: string }>; error?: string };
  if (!response.ok) throw new Error(data.error || 'تعذر رفع الصور.');
  return data.files || [];
}

function parsePairLines(value: string) {
  const result: Record<string, string> = {};
  for (const entry of value.split(/[\r\n]+/)) {
    const separator = entry.indexOf('=');
    if (separator < 1) continue;
    const key = entry.slice(0, separator).trim();
    const item = entry.slice(separator + 1).trim();
    if (key && item) result[key] = item;
  }
  return result;
}

async function apiGet<T>(view: string, params?: Record<string, string>): Promise<T> {
  const search = new URLSearchParams({ view, ...(params || {}) });
  const response = await fetch('/api/admin?' + search.toString(), {
    cache: 'no-store', credentials: 'same-origin'
  });
  const data = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(data.error || 'تعذر تحميل البيانات.');
  return data;
}

async function apiPost<T>(payload: Record<string, unknown>): Promise<T> {
  const response = await fetch('/api/admin', {
    method: 'POST', credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(data.error || 'تعذر تنفيذ العملية.');
  return data;
}

function Field({ label, children, wide = false }: { label: string; children: ReactNode; wide?: boolean }) {
  return <label className={cn(styles['admin-form-field'], wide && styles.wide)}><span>{label}</span>{children}</label>;
}

function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cn(styles['admin-input'], props.className)} />;
}

function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={cn(styles['admin-textarea'], props.className)} />;
}

function Button({
  children, kind = 'primary', ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { kind?: 'primary' | 'secondary' | 'danger' | 'quiet' }) {
  const className = kind === 'primary' ? styles['admin-primary-button']
    : kind === 'secondary' ? styles['admin-secondary-button']
      : kind === 'danger' ? styles['admin-danger-button'] : styles['admin-quiet-button'];
  return <button {...props} className={cn(className, props.className)}>{children}</button>;
}

function Panel({ title, subtitle, action, children }: { title: string; subtitle?: string; action?: ReactNode; children: ReactNode }) {
  return <section className={styles['admin-panel']}>
    <header className={styles['admin-panel-header']}>
      <div><h2>{title}</h2>{subtitle ? <p>{subtitle}</p> : null}</div>
      {action}
    </header>
    {children}
  </section>;
}

export default function AdminDashboard({ initialAdmin }: { initialAdmin: AdminUser }) {
  const router = useRouter();
  const [view, setView] = useState<ViewKey>('dashboard');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [stats, setStats] = useState<Record<string, number>>({});
  const [products, setProducts] = useState<ProductRow[]>([]);
  const [categories, setCategories] = useState<CategoryRow[]>([]);
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [job, setJob] = useState<ImportJob | null>(null);
  const [reviews, setReviews] = useState<ReviewRow[]>([]);
  const [admins, setAdmins] = useState<AdminUser[]>([]);
  const [store, setStore] = useState<StoreData>({ settings: {}, pages: [], banners: [] });
  const [query, setQuery] = useState('');
  const [productEditor, setProductEditor] = useState<ProductRow | null | false>(false);
  const [categoryEditor, setCategoryEditor] = useState<CategoryRow | null | false>(false);
  const [singleUrl, setSingleUrl] = useState('');\n  const [categoryUrl, setCategoryUrl] = useState('https://www.al-brag-ksa.store/catalog?category=Apple-iPhone-18-Pro-Max');\n  const [categorySampleUrl, setCategorySampleUrl] = useState('https://www.al-brag-ksa.store/product2/1902');
  const [singlePreview, setSinglePreview] = useState<Record<string, unknown> | null>(null);
  const [caseMaskLinks, setCaseMaskLinks] = useState<Record<string, string>>({});
  const [singleBusy, setSingleBusy] = useState(false);
  const [selectedPage, setSelectedPage] = useState<string>('privacy');
  const [pageContent, setPageContent] = useState('');
  const [adminForm, setAdminForm] = useState({ name: '', email: '', password: '' });
  const [securityForm, setSecurityForm] = useState({ currentPassword: '', newPassword: '' });

  const isSuperAdmin = initialAdmin.role === 'super_admin';
  const activeNav = NAV.find((item) => item.id === view);
  const currentPage = useMemo(
    () => store.pages.find((page) => page.key === selectedPage),
    [store.pages, selectedPage]
  );

  const loadView = useCallback(async (target: ViewKey = view) => {
    setLoading(true);
    setError('');
    try {
      if (target === 'dashboard') {
        const data = await apiGet<{ stats: Record<string, number> }>('dashboard');
        setStats(data.stats || {});
      } else if (target === 'products') {
        const suffix = query.trim() ? '&q=' + encodeURIComponent(query.trim()) : '';
        const [data, categoryData] = await Promise.all([
          apiGet<{ products: ProductRow[] }>('products', query.trim() ? { q: query.trim() } : undefined),
          apiGet<{ categories: CategoryRow[] }>('categories')
        ]);
        setProducts(data.products || []);
        setCategories(categoryData.categories || []);
      } else if (target === 'categories') {
        const data = await apiGet<{ categories: CategoryRow[] }>('categories');
        setCategories(data.categories || []);
      } else if (target === 'orders') {
        const data = await apiGet<{ orders: OrderRow[] }>('orders');
        setOrders(data.orders || []);
      } else if (target === 'import') {
        const data = await apiGet<{ job: ImportJob | null }>('import');
        setJob(data.job || null);
      } else if (target === 'store') {
        const data = await apiGet<StoreData>('store');
        setStore({ settings: data.settings || {}, pages: data.pages || [], banners: data.banners || [] });
      } else if (target === 'reviews') {
        const data = await apiGet<{ reviews: ReviewRow[] }>('reviews');
        setReviews(data.reviews || []);
      } else if (target === 'admins') {
        if (!isSuperAdmin) throw new Error('إدارة الحسابات متاحة للمدير الرئيسي فقط.');
        const data = await apiGet<{ admins: AdminUser[] }>('admins');
        setAdmins(data.admins || []);
      }
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : 'حدث خطأ أثناء تحميل الصفحة.';
      if (message.includes('جلسة الإدارة')) {
        router.replace('/admin/login');
        return;
      }
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [view, query, isSuperAdmin, router]);

  useEffect(() => { void loadView(view); }, [view, loadView]);

  useEffect(() => {
    if (currentPage) setPageContent(currentPage.content || '');
    else setPageContent('');
  }, [currentPage]);

  async function runAction(payload: Record<string, unknown>, refreshView: ViewKey = view) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await apiPost<{ message?: string }>(payload);
      setNotice(result.message || 'تم تنفيذ العملية بنجاح.');
      setProductEditor(false);
      setCategoryEditor(false);
      await loadView(refreshView);
      return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'تعذر تنفيذ العملية.');
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    try { await fetch('/api/admin/auth', { method: 'DELETE', credentials: 'same-origin' }); } catch { /* Cookie is cleared by the endpoint. */ }
    router.replace('/admin/login');
    router.refresh();
  }

  function changeView(target: ViewKey) {
    setError('');
    setNotice('');
    if (target === 'admins' && !isSuperAdmin) return;
    setView(target);
    setQuery('');
    if (typeof window !== 'undefined' && window.innerWidth < 760) {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }

  async function submitProduct(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    const form = new FormData(event.currentTarget);
    const categoryId = String(form.get('categoryId') || '');
    const storageOptions = parseLines(String(form.get('storageOptions') || ''));
    const storagePrices = parseStoragePrices(String(form.get('storagePrices') || ''));
    const colors = parseLines(String(form.get('colors') || ''));
    const existingImages = parseLines(String(form.get('images') || ''));
    try {
      const selectedImages = form.getAll('imageFiles').filter((file): file is File => file instanceof File && file.size > 0);
      let images = existingImages;
      if (selectedImages.length) {
        const uploaded = await uploadAdminMedia(selectedImages);
        images = [...images, ...uploaded.map((item) => item.ref)];
      }
      if (images.length > 10) {
        setError('الحد الأقصى 10 صور للمنتج. احذف بعض الروابط قبل إضافة صور أخرى.');
        return;
      }
      const payload: Record<string, unknown> = {
        action: 'save-product',
        ...(productEditor ? { id: productEditor.id } : {}),
        name: form.get('name'),
        categoryId,
        price: Number(form.get('price')),
        oldPrice: form.get('oldPrice') ? Number(form.get('oldPrice')) : undefined,
        shortDescription: form.get('shortDescription'),
        details: form.get('details'),
        colors,
        storageOptions,
        storagePrices,
        specifications: parseLines(String(form.get('specifications') || '')),
        colorImages: parsePairLines(String(form.get('colorImages') || '')),
        images
      };
      await runAction(payload, 'products');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'تعذر رفع الصور أو حفظ المنتج.');
    }
  }

  async function submitCategory(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await runAction({
      action: 'save-category',
      ...(categoryEditor ? { id: categoryEditor.id } : {}),
      name: form.get('name'),
      description: form.get('description')
    }, 'categories');
  }

  async function changeOrder(order: OrderRow, status: string) {
    const reason = status === 'cancelled' ? window.prompt('سبب الإلغاء (اختياري):') || '' : '';
    await runAction({ action: 'update-order', id: order.id, status, reason }, 'orders');
  }

  async function discoverCatalog() {
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await apiPost<{ message: string; discovery: { urls: string[]; scannedSitemaps: number; scannedPages: number; warnings: string[] }; job: ImportJob }>({ action: 'discover-catalog' });
      setJob(result.job);
      setNotice('اكتمل الفحص: تم العثور على ' + result.discovery.urls.length + ' رابط منتج.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'تعذر فحص الموقع.');
    } finally { setBusy(false); }
  }

  async function discoverCategoryCatalog() {
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await apiPost<{
        message: string;
        job?: ImportJob;
        discovery?: { urls?: string[]; scannedPages?: number; warnings?: string[] };
      }>({
        action: 'discover-category-catalog',
        categoryUrl,
        sampleProductUrl: categorySampleUrl
      });
      setJob(result.job || null);
      const count = result.discovery?.urls?.length || 0;
      setNotice(count
        ? `تم اكتشاف ${count} رابط منتج في القسم. ابدأ استيراد الدفعات من نفس الصفحة.`
        : result.message || 'لم يتم العثور على منتجات في القسم.');
      if (!count && result.discovery?.warnings?.length) setError(result.discovery.warnings.join(' · '));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'تعذر اكتشاف منتجات القسم.');
    } finally { setBusy(false); }
  }

  async function processBatch() {
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await apiPost<{ message: string; job?: ImportJob }>({ action: 'process-catalog-batch' });
      if (result.job) setJob(result.job);
      setNotice(result.message || 'تمت معالجة الدفعة.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'تعذر استيراد الدفعة.');
    } finally { setBusy(false); }
  }

  async function stopImport() {
    if (!window.confirm('هل تريد إيقاف الاستيراد؟ المنتجات التي تم حفظها بالفعل ستبقى في المتجر.')) return;
    setBusy(true); setError('');
    try {
      const result = await apiPost<{ message: string; job?: ImportJob }>({ action: 'stop-catalog-import' });
      setJob(result.job || null); setNotice(result.message || 'تم إيقاف الاستيراد.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'تعذر إيقاف الاستيراد.');
    } finally { setBusy(false); }
  }

  async function previewProduct() {
    setSingleBusy(true); setSinglePreview(null); setError(''); setNotice('');
    try {
      const result = await apiPost<{ preview: Record<string, unknown> }>({ action: 'preview-single-product', url: singleUrl });
      setSinglePreview(result.preview);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'تعذر قراءة صفحة المنتج.');
    } finally { setSingleBusy(false); }
  }

  async function confirmSingleProduct() {
    setSingleBusy(true); setError('');
    try {
      const result = await apiPost<{ message: string }>({ action: 'confirm-single-product', url: singleUrl });
      setNotice(result.message || 'تم استيراد المنتج.');
      setSinglePreview(null); setSingleUrl('');
      await loadView('products');
      setView('products');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'تعذر حفظ المنتج.');
    } finally { setSingleBusy(false); }
  }

  async function saveStoreSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true); setError(''); setNotice('');
    try {
      const logoFiles = form.getAll('logoFile').filter((file): file is File => file instanceof File && file.size > 0);
      const iconOneFiles = form.getAll('iconOneFile').filter((file): file is File => file instanceof File && file.size > 0);
      const iconTwoFiles = form.getAll('iconTwoFile').filter((file): file is File => file instanceof File && file.size > 0);
      const [uploadedLogo, uploadedIconOne, uploadedIconTwo] = await Promise.all([
        logoFiles.length ? uploadAdminMedia(logoFiles.slice(0, 1)) : Promise.resolve([]),
        iconOneFiles.length ? uploadAdminMedia(iconOneFiles.slice(0, 1)) : Promise.resolve([]),
        iconTwoFiles.length ? uploadAdminMedia(iconTwoFiles.slice(0, 1)) : Promise.resolve([])
      ]);
      const logoUrl = String(form.get('logoImageUrl') || '').trim();
      const payload: Record<string, unknown> = {
        action: 'save-store-settings',
        projectName: form.get('projectName'),
        whatsappNumber: form.get('whatsappNumber'),
        vatNumber: form.get('vatNumber'),
        logoBackgroundMode: form.get('logoBackgroundMode'),
        iconOneImageUrl: form.get('iconOneImageUrl'),
        iconOneLinkUrl: form.get('iconOneLinkUrl'),
        iconTwoImageUrl: form.get('iconTwoImageUrl'),
        iconTwoLinkUrl: form.get('iconTwoLinkUrl'),
        ...(uploadedLogo.length ? { logoMediaId: uploadedLogo[0].id } : {}),
        ...(uploadedIconOne.length ? { iconOneMediaId: uploadedIconOne[0].id } : {}),
        ...(uploadedIconTwo.length ? { iconTwoMediaId: uploadedIconTwo[0].id } : {}),
        ...(!uploadedLogo.length && logoUrl ? { logoImageUrl: logoUrl } : {}),
        ...(form.get('removeLogo') === 'on' && !uploadedLogo.length && !logoUrl ? { removeLogo: true } : {})
      };
      const result = await apiPost<{ message?: string }>(payload);
      setNotice(result.message || 'تم حفظ الإعدادات.');
      await loadView('store');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'تعذر حفظ إعدادات المتجر.');
    } finally { setBusy(false); }
  }

  async function savePage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await runAction({ action: 'save-store-page', key: selectedPage, content: pageContent }, 'store');
  }

  async function addBanner(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    setBusy(true); setError(''); setNotice('');
    try {
      const selected = form.get('bannerFile');
      if (selected instanceof File && selected.size > 0) {
        const uploaded = await uploadAdminMedia([selected]);
        const result = await apiPost<{ message?: string }>({ action: 'add-banner-media', mediaId: uploaded[0]?.id, alt: form.get('alt') });
        setNotice(result.message || 'تمت إضافة صورة السلايدر.');
      } else {
        const imageUrl = String(form.get('imageUrl') || '').trim();
        if (!imageUrl) throw new Error('أدخل رابط صورة أو ارفع ملفًا من جهازك.');
        const result = await apiPost<{ message?: string }>({ action: 'add-banner', imageUrl, alt: form.get('alt') });
        setNotice(result.message || 'تمت إضافة صورة السلايدر.');
      }
      formElement.reset();
      await loadView('store');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'تعذرت إضافة صورة السلايدر.');
    } finally { setBusy(false); }
  }

  async function submitAdmin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const okay = await runAction({ action: 'create-admin', ...adminForm }, 'admins');
    if (okay) setAdminForm({ name: '', email: '', password: '' });
  }

  async function submitPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const okay = await runAction({ action: 'change-my-password', ...securityForm }, 'security');
    if (okay) setSecurityForm({ currentPassword: '', newPassword: '' });
  }

  async function createCaseMaskLink(product: ProductRow) {
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await apiPost<{ url: string; message?: string }>({ action: 'create-case-mask-session', id: product.id });
      setCaseMaskLinks((current) => ({ ...current, [product.id]: result.url }));
      setNotice(result.message || 'تم إنشاء رابط التحديد.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'تعذر إنشاء رابط تحديد الكفر.');
    } finally { setBusy(false); }
  }

  const filteredProducts = products;
  const activeJob = Boolean(job && ['ready', 'running'].includes(job.status));
  const importProgress = job?.urls?.length ? Math.min(100, Math.round((job.cursor / job.urls.length) * 100)) : 0;

  return (
    <div className={styles['admin-layout']}>
      <aside className={styles['admin-sidebar']}>
        <div className={styles['admin-sidebar-brand']}>
          <div className={styles['admin-brand-mark']}>أ</div>
          <div><strong>أرض الجوال</strong><small>لوحة الإدارة المركزية</small></div>
        </div>
        <div>
          <div className={styles['admin-nav-label']}>إدارة المتجر</div>
          <nav className={styles['admin-nav']}>
            {NAV.map((item) => {
              if (item.id === 'admins' && !isSuperAdmin) return null;
              return <button key={item.id} type="button" onClick={() => changeView(item.id)}
                className={cn(styles['admin-nav-button'], view === item.id && styles['is-active'])}>
                <span>{item.icon}</span><span>{item.label}</span>
              </button>;
            })}
          </nav>
        </div>
        <div className={styles['admin-sidebar-bottom']}>
          <a href="/" target="_blank" rel="noreferrer">↗ فتح المتجر</a>
          <button type="button" onClick={logout}>⤴ تسجيل الخروج</button>
        </div>
      </aside>

      <main className={styles['admin-main']}>
        <header className={styles['admin-topbar']}>
          <div>
            <h1>{activeNav?.label || 'لوحة الإدارة'}</h1>
            <p>إدارة موحدة — التغييرات محفوظة مباشرة في قاعدة بيانات المتجر</p>
          </div>
          <div className={styles['admin-user-chip']}>
            <span className={styles['admin-user-avatar']}>{initialAdmin.name.slice(0, 1) || 'م'}</span>
            <span><strong>{initialAdmin.name}</strong><small>{initialAdmin.email}</small></span>
          </div>
        </header>

        <div className={styles['admin-content']}>
          {notice ? <div className={styles['admin-flash']} role="status">{notice}</div> : null}
          {error ? <div className={styles['admin-error']} role="alert">{error}</div> : null}
          {loading ? <div className={styles['admin-loading']}>جارٍ تحميل بيانات الإدارة...</div> : null}

          {!loading && view === 'dashboard' ? (
            <>
              <div className={styles['admin-grid']}>
                {[
                  ['المنتجات النشطة', stats.products ?? 0, '▦'],
                  ['الأقسام', stats.categories ?? 0, '▤'],
                  ['إجمالي الطلبات', stats.orders ?? 0, '▣'],
                  ['طلبات تحتاج متابعة', stats.activeOrders ?? 0, '◷'],
                  ['طلبات تم شحنها', stats.shippedOrders ?? 0, '⇢'],
                  ['صور السلايدر', stats.banners ?? 0, '▧'],
                  ['تقييمات العملاء', stats.reviews ?? 0, '☆'],
                  ['إيراد الطلبات المكتملة', money(stats.completedRevenue ?? 0), 'ر.س']
                ].map(([label, value, icon]) => (
                  <div className={styles['admin-stat-card']} key={String(label)}>
                    <div><span>{label}</span><strong>{value}</strong></div>
                    <span className={styles['admin-stat-icon']}>{icon}</span>
                  </div>
                ))}
              </div>
              <Panel title="وصول سريع" subtitle="كل إجراء من هذه الشاشة يستخدم نفس قاعدة البيانات التي يتصل بها بوت الإدارة.">
                <div className={styles['admin-actions']}>
                  <Button onClick={() => { setProductEditor(null); changeView('products'); }}>＋ إضافة منتج</Button>
                  <Button kind="secondary" onClick={() => { setCategoryEditor(null); changeView('categories'); }}>＋ إضافة قسم</Button>
                  <Button kind="secondary" onClick={() => changeView('orders')}>متابعة الطلبات</Button>
                  <Button kind="secondary" onClick={() => changeView('import')}>استيراد كتالوج البرق</Button>
                </div>
              </Panel>
              <Panel title="حالة الإدارة" subtitle="البيانات تُقرأ من MongoDB مباشرة دون قائمة منتجات محلية بديلة.">
                <div className={styles['admin-section-list']}>
                  <div className={styles['admin-section-row']}><strong>حساب الدخول</strong><span className={styles['admin-pill success']}>نشط</span></div>
                  <div className={styles['admin-section-row']}><strong>قاعدة البيانات</strong><span className={styles['admin-pill']}>ee_store</span></div>
                  <div className={styles['admin-section-row']}><strong>الإدارة المشتركة مع البوت</strong><span className={styles['admin-pill success']}>مفعّلة</span></div>
                </div>
              </Panel>
            </>
          ) : null}

          {!loading && view === 'products' ? (
            <>
              <Panel title="كتالوج المنتجات" subtitle="إضافة وتعديل وحذف المنتجات التي تظهر في المتجر." action={<Button onClick={() => setProductEditor(null)}>＋ منتج جديد</Button>}>
                <div className={styles['admin-toolbar']}>
                  <Input placeholder="ابحث باسم المنتج أو القسم أو SKU..." value={query} onChange={(event) => setQuery(event.target.value)} />
                  <Button kind="secondary" onClick={() => void loadView('products')}>بحث وتحديث</Button>
                </div>
                <div className={styles['admin-table-wrap']}>
                  <table className={styles['admin-table']}>
                    <thead><tr><th>المنتج</th><th>القسم</th><th>السعر</th><th>التخزين</th><th>المصدر</th><th>الإجراءات</th></tr></thead>
                    <tbody>
                      {filteredProducts.map((product) => (
                        <tr key={product.id}>
                          <td><div className={styles['admin-product-cell']}>
                            <img className={styles['admin-product-thumb']} src={product.images?.[0] ? (/^https?:\/\//.test(product.images[0]) ? product.images[0] : '/api/products/' + product.id + '/image?index=0') : '/product-image-placeholder.svg'} alt="" onError={(event) => { event.currentTarget.src = '/product-image-placeholder.svg'; }} />
                            <span><strong>{product.name}</strong><br/><small className={styles['admin-muted']}>{product.sourceSku || product.id.slice(-7)}</small></span>
                          </div></td>
                          <td>{product.category}</td>
                          <td><strong>{money(product.price)}</strong>{product.oldPrice ? <><br/><small className={styles['admin-muted']}>قبل {money(product.oldPrice)}</small></> : null}</td>
                          <td>{product.storageOptions?.join('، ') || '—'}</td>
                          <td>{product.sourceProductUrl ? <span className={styles['admin-pill']}>مستورد</span> : <span className={styles['admin-pill']}>يدوي</span>}</td>
                          <td><div className={styles['admin-row-buttons']}>
                            <Button kind="secondary" onClick={() => setProductEditor(product)}>تعديل</Button>
                            {/جراب|كفر|phone\s*case|case\s*cover|\bcase\b/i.test(product.name + ' ' + product.category + ' ' + product.details) ? <Button kind="quiet" onClick={() => void createCaseMaskLink(product)} disabled={busy}>تحديد الكفر</Button> : null}
                            {caseMaskLinks[product.id] ? <a className={styles['admin-secondary-button']} href={caseMaskLinks[product.id]} target="_blank" rel="noreferrer">فتح أداة التحديد ↗</a> : null}
                            <Button kind="danger" onClick={() => { if (window.confirm('حذف المنتج «' + product.name + '»؟')) void runAction({ action: 'delete-product', id: product.id }, 'products'); }}>حذف</Button>
                          </div></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {!products.length ? <div className={styles['admin-empty']}>لا توجد منتجات مسجلة في قاعدة البيانات حتى الآن.</div> : null}
                </div>
              </Panel>
              {productEditor !== false ? (
                <div className={styles['admin-modal-backdrop']} onMouseDown={(event) => { if (event.target === event.currentTarget) setProductEditor(false); }}>
                  <section className={styles['admin-modal']}>
                    <div className={styles['admin-panel-header']}><div><h2>{productEditor ? 'تعديل المنتج' : 'إضافة منتج جديد'}</h2><p>حفظ مباشر في كتالوج المتجر.</p></div><Button kind="quiet" onClick={() => setProductEditor(false)}>إغلاق ✕</Button></div>
                    <form onSubmit={submitProduct} className={styles['admin-editor-grid']}>
                      <Field label="اسم المنتج"><Input name="name" required minLength={2} maxLength={120} defaultValue={productEditor?.name || ''}/></Field>
                      <Field label="القسم"><select name="categoryId" required className={styles['admin-select']} defaultValue={productEditor?.categoryId || categories[0]?.id || ''}><option value="" disabled>اختر القسم</option>{categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></Field>
                      <Field label="السعر الحالي (ر.س)"><Input name="price" type="number" min="0.01" step="0.01" required defaultValue={productEditor?.price ?? ''}/></Field>
                      <Field label="السعر السابق (اختياري)"><Input name="oldPrice" type="number" min="0" step="0.01" defaultValue={productEditor?.oldPrice ?? ''}/></Field>
                      <Field label="وصف مختصر"><Input name="shortDescription" maxLength={300} defaultValue={productEditor?.shortDescription || ''}/></Field>
                      <Field label="الألوان (كل لون في سطر)"><Textarea name="colors" rows={3} defaultValue={lines(productEditor?.colors)}/></Field>
                      <Field label="مساحات التخزين (كل مساحة في سطر)"><Textarea name="storageOptions" rows={3} defaultValue={lines(productEditor?.storageOptions)}/></Field>
                      <Field label="سعر كل مساحة: 512GB=999"><Textarea name="storagePrices" rows={3} defaultValue={Object.entries(productEditor?.storagePrices || {}).map(([key, value]) => key + '=' + value).join('\n')}/></Field>
                      <Field label="المواصفات (كل مواصفة في سطر)"><Textarea name="specifications" rows={4} defaultValue={lines(productEditor?.specifications)}/></Field>
                      <Field label="روابط الصور أو معرّفات صور البوت (كل رابط في سطر)" wide><Textarea name="images" rows={4} defaultValue={lines(productEditor?.images)}/></Field>
                      <Field label="رفع صور من جهازك (حتى 10 صور، 4 ميجابايت إجمالي الرفع)" wide><Input name="imageFiles" type="file" accept="image/jpeg,image/png,image/webp,image/gif,image/avif" multiple/></Field>
                      <Field label="صور الألوان: اللون=رابط الصورة" wide><Textarea name="colorImages" rows={3} defaultValue={Object.entries(productEditor?.colorImages || {}).map(([color, image]) => color + '=' + image).join('\n')}/></Field>
                      <Field label="الوصف والتفاصيل" wide><Textarea name="details" rows={6} required minLength={2} maxLength={3000} defaultValue={productEditor?.details || ''}/></Field>
                      <div className={cn(styles['admin-actions'], styles.wide)}>
                        <Button type="submit" disabled={busy}>{busy ? 'جارٍ الحفظ...' : 'حفظ المنتج'}</Button>
                        <Button type="button" kind="quiet" onClick={() => setProductEditor(false)}>إلغاء</Button>
                      </div>
                    </form>
                  </section>
                </div>
              ) : null}
            </>
          ) : null}

          {!loading && view === 'categories' ? (
            <Panel title="إدارة الأقسام" subtitle="الترتيب الذي تحفظه هنا ينعكس على ترتيب أقسام المتجر." action={<Button onClick={() => setCategoryEditor(null)}>＋ قسم جديد</Button>}>
              <div className={styles['admin-section-list']}>
                {categories.map((category, index) => (
                  <div className={styles['admin-section-row']} key={category.id}>
                    <div><strong>{index + 1}. {category.name}</strong><br/><small className={styles['admin-muted']}>{category.productCount || 0} منتج · {category.description || 'بدون وصف'}</small></div>
                    <div className={styles['admin-row-buttons']}>
                      <Button kind="quiet" disabled={index === 0 || busy} onClick={() => {
                        const ids = categories.map((item) => item.id); [ids[index - 1], ids[index]] = [ids[index], ids[index - 1]];
                        void runAction({ action: 'reorder-categories', ids }, 'categories');
                      }}>↑</Button>
                      <Button kind="quiet" disabled={index === categories.length - 1 || busy} onClick={() => {
                        const ids = categories.map((item) => item.id); [ids[index + 1], ids[index]] = [ids[index], ids[index + 1]];
                        void runAction({ action: 'reorder-categories', ids }, 'categories');
                      }}>↓</Button>
                      <Button kind="secondary" onClick={() => setCategoryEditor(category)}>تعديل</Button>
                      <Button kind="danger" onClick={() => { if (window.confirm('حذف القسم وإخفاء المنتجات التابعة له من المتجر؟')) void runAction({ action: 'delete-category', id: category.id }, 'categories'); }}>حذف</Button>
                    </div>
                  </div>
                ))}
                {!categories.length ? <div className={styles['admin-empty']}>لا توجد أقسام حتى الآن.</div> : null}
              </div>
              {categoryEditor !== false ? (
                <div className={styles['admin-modal-backdrop']} onMouseDown={(event) => { if (event.target === event.currentTarget) setCategoryEditor(false); }}>
                  <section className={styles['admin-modal']}>
                    <div className={styles['admin-panel-header']}><h2>{categoryEditor ? 'تعديل القسم' : 'إضافة قسم'}</h2><Button kind="quiet" onClick={() => setCategoryEditor(false)}>إغلاق ✕</Button></div>
                    <form onSubmit={submitCategory}>
                      <Field label="اسم القسم"><Input name="name" required minLength={2} maxLength={80} defaultValue={categoryEditor?.name || ''}/></Field>
                      <Field label="الوصف (اختياري)"><Textarea name="description" rows={3} defaultValue={categoryEditor?.description || ''}/></Field>
                      <div className={styles['admin-actions']}><Button type="submit" disabled={busy}>حفظ</Button><Button type="button" kind="quiet" onClick={() => setCategoryEditor(false)}>إلغاء</Button></div>
                    </form>
                  </section>
                </div>
              ) : null}
            </Panel>
          ) : null}

          {!loading && view === 'orders' ? (
            <Panel title="طلبات العملاء" subtitle="بيانات البطاقات الحساسة لا تظهر في لوحة الإدارة. تحديث الحالة يرسل إشعارًا للعميل عند الحاجة.">
              <div className={styles['admin-section-list']}>
                {orders.map((order) => (
                  <article className={styles['admin-order-card']} key={order.id}>
                    <div className={styles['admin-order-top']}>
                      <strong>{order.orderNumber || '#' + order.id.slice(-6)}</strong>
                      <span className={cn(styles['admin-pill'], order.status === 'completed' ? styles.success : order.status === 'cancelled' ? styles.danger : order.status === 'shipped' ? styles.warning : '')}>{ORDER_STATUS_LABELS[order.status] || order.status}</span>
                    </div>
                    <div className={styles['admin-order-grid']}>
                      <span>العميل: <strong>{order.customer?.name || '—'}</strong></span>
                      <span>الهاتف: {order.customer?.phone || '—'}</span>
                      <span>الإجمالي: <strong>{money(order.total)}</strong></span>
                      <span>التاريخ: {formatDate(order.createdAt)}</span>
                      <span>طريقة الدفع: {String(order.paymentMethod || '—')}</span>
                      <span>حالة الدفع: {String(order.paymentStatus || '—')}</span>
                    </div>
                    <div className={styles['admin-order-items']}>
                      {order.items?.map((item, index) => <div key={index}>{item.name || 'منتج'} × {item.quantity || 1}{item.color ? ' · ' + item.color : ''}{item.storage ? ' · ' + item.storage : ''}</div>)}
                      <div>العنوان: {order.customer?.address || '—'}</div>
                    </div>
                    {order.status === 'cancelled' && order.cancellationReason ? <small className={styles['admin-muted']}>سبب الإلغاء: {order.cancellationReason}</small> : null}
                    <div className={styles['admin-actions']}>
                      {['new', 'confirmed', 'preparing'].includes(order.status) ? <Button kind="secondary" onClick={() => void changeOrder(order, 'shipped')}>تأكيد الشحن</Button> : null}
                      {['new', 'confirmed', 'preparing', 'shipped'].includes(order.status) ? <Button onClick={() => void changeOrder(order, 'completed')}>إكمال الطلب</Button> : null}
                      {['new', 'confirmed', 'preparing', 'shipped'].includes(order.status) ? <Button kind="danger" onClick={() => void changeOrder(order, 'cancelled')}>إلغاء الطلب</Button> : null}
                      {order.customerNotificationKey ? <>
                        <Button kind="quiet" onClick={() => void runAction({ action: 'order-notice', id: order.id, kind: 'otp' }, 'orders')}>طلب OTP</Button>
                        <Button kind="quiet" onClick={() => void runAction({ action: 'order-notice', id: order.id, kind: 'balance' }, 'orders')}>لا يوجد رصيد</Button>
                        <Button kind="quiet" onClick={() => void runAction({ action: 'order-notice', id: order.id, kind: 'card' }, 'orders')}>بيانات البطاقة</Button>
                      </> : null}
                    </div>
                  </article>
                ))}
                {!orders.length ? <div className={styles['admin-empty']}>لا توجد طلبات مسجلة.</div> : null}
              </div>
            </Panel>
          ) : null}

          {!loading && view === 'import' ? (
            <>
              <Panel title="استيراد منتجات قسم محدد" subtitle="انسخ رابط القسم من موقع البرق المضيء. يمكن إضافة رابط منتج كمثال لضمان إدخاله ضمن نفس العملية.">
                <div className={styles['admin-editor-grid']}>
                  <Field label="رابط القسم من الموقع" wide>
                    <Input value={categoryUrl} onChange={(event) => setCategoryUrl(event.target.value)} placeholder="https://www.al-brag-ksa.store/catalog?category=..." />
                  </Field>
                  <Field label="رابط منتج من القسم (اختياري)" wide>
                    <Input value={categorySampleUrl} onChange={(event) => setCategorySampleUrl(event.target.value)} placeholder="https://www.al-brag-ksa.store/product2/1902" />
                  </Field>
                </div>
                <div className={styles['admin-actions']}>
                  <Button onClick={() => void discoverCategoryCatalog()} disabled={busy || activeJob || !categoryUrl.trim()}>
                    {busy ? 'جارٍ فحص القسم...' : 'اكتشاف منتجات هذا القسم'}
                  </Button>
                </div>
              </Panel>

              <Panel title="استيراد كتالوج البرق المضيء" subtitle="الاستيراد هنا والبوت يشتركان في سجل عملية واحد داخل MongoDB.">
                <div className={styles['admin-actions']}>
                  <Button onClick={() => void discoverCatalog()} disabled={busy || activeJob}>⌕ اكتشاف المنتجات من الموقع</Button>
                  <Button kind="secondary" onClick={() => void loadView('import')} disabled={busy}>تحديث حالة الاستيراد</Button>
                </div>
                {job ? (
                  <div style={{ marginTop: 20, display: 'grid', gap: 16 }}>
                    <div className={styles['admin-order-top']}>
                      <strong>حالة العملية: {job.status === 'completed' ? 'مكتملة' : job.status === 'stopped' ? 'متوقفة' : job.status === 'failed' ? 'فشلت' : job.status === 'running' ? 'قيد التنفيذ' : 'جاهزة'}</strong>
                      <span className={styles['admin-pill']}>{job.cursor} / {job.urls?.length || 0}</span>
                    </div>
                    <div className={styles['admin-progress']}><span style={{ width: importProgress + '%' }}/></div>
                    <div className={styles['admin-import-stats']}>
                      <div><small>تم استيراده</small><strong>{job.imported}</strong></div>
                      <div><small>مكرر / متخطى</small><strong>{job.skipped}</strong></div>
                      <div><small>فشل</small><strong>{job.failed}</strong></div>
                      <div><small>نسبة الإنجاز</small><strong>{importProgress}%</strong></div>
                    </div>
                    <small className={styles['admin-muted']}>خرائط الموقع: {job.scannedSitemaps || 0} · الصفحات العامة: {job.scannedPages || 0} · بدأها: {String(job.startedBy || '—')}</small>
                    {job.lastBatch?.length ? <div className={styles['admin-section-list']}>{job.lastBatch.map((item, index) => <div key={index} className={styles['admin-section-row']}><span>{item.name}</span><span className={cn(styles['admin-pill'], item.state === 'imported' ? styles.success : item.state === 'failed' ? styles.danger : '')}>{item.state === 'imported' ? 'تم الاستيراد' : item.state === 'failed' ? 'فشل' : 'مكرر'}</span></div>)}</div> : null}
                    {job.warnings?.length ? <div className={styles['admin-error']}>{job.warnings.slice(0, 5).join(' · ')}</div> : null}
                    {job.errors?.length ? <details><summary>تفاصيل الأخطاء ({job.errors.length})</summary><ul>{job.errors.slice(-10).map((item, index) => <li key={index}>{item}</li>)}</ul></details> : null}
                    <div className={styles['admin-actions']}>
                      {activeJob ? <Button onClick={() => void processBatch()} disabled={busy}>{busy ? 'جارٍ تنفيذ الدفعة...' : 'استيراد الدفعة التالية (3 منتجات)'}</Button> : null}
                      {activeJob ? <Button kind="danger" onClick={() => void stopImport()} disabled={busy}>إيقاف الاستيراد</Button> : null}
                    </div>
                  </div>
                ) : <div className={styles['admin-empty']}>لا توجد عملية استيراد محفوظة. ابدأ باكتشاف المنتجات.</div>}
              </Panel>

              <Panel title="استيراد منتج واحد" subtitle="أدخل رابط صفحة منتج لعرض معاينته ثم أضفه إلى الكتالوج.">
                <div className={styles['admin-toolbar']}>
                  <Input value={singleUrl} onChange={(event) => setSingleUrl(event.target.value)} placeholder="https://www.al-brag-ksa.store/product2/1901"/>
                  <Button onClick={() => void previewProduct()} disabled={singleBusy || !singleUrl.trim()}>{singleBusy ? 'جارٍ الفحص...' : 'معاينة الرابط'}</Button>
                </div>
                {singlePreview ? <div className={styles['admin-preview-card']}>
                  <strong>{String(singlePreview.name || 'منتج بدون اسم')}</strong>
                  <span>{money(singlePreview.price)}</span>
                  <span className={styles['admin-muted']}>القسم: {String(singlePreview.sourceCategory || '—')} · الصور: {Array.isArray(singlePreview.images) ? singlePreview.images.length : 0}</span>
                  <p>{String(singlePreview.shortDescription || '')}</p>
                  <div className={styles['admin-actions']}><Button onClick={() => void confirmSingleProduct()} disabled={singleBusy}>تأكيد الاستيراد</Button><Button kind="quiet" onClick={() => setSinglePreview(null)}>إلغاء المعاينة</Button></div>
                </div> : null}
              </Panel>
            </>
          ) : null}

          {!loading && view === 'store' ? (
            <>
              <Panel title="بيانات المتجر والفوتر" subtitle="يتم حفظ الإعدادات في السجلات نفسها التي يستخدمها البوت.">
                <form onSubmit={saveStoreSettings} className={styles['admin-editor-grid']}>
                  <Field label="اسم المتجر"><Input name="projectName" defaultValue={String(store.settings.brand?.projectName || 'أرض الجوال')}/></Field>
                  <Field label="رقم واتساب الدعم"><Input name="whatsappNumber" inputMode="tel" defaultValue={String(store.settings.contact?.whatsappNumber || '')}/></Field>
                  <Field label="الرقم الضريبي"><Input name="vatNumber" defaultValue={String(store.settings.footer?.vatNumber || '')}/></Field>
                  <Field label="رابط صورة الشعار HTTPS"><Input name="logoImageUrl" type="url" placeholder="https://..." defaultValue={String(store.settings.branding?.logoImageUrl || '')}/></Field>
                  <Field label="أو ارفع صورة الشعار من جهازك"><Input name="logoFile" type="file" accept="image/jpeg,image/png,image/webp,image/gif,image/avif"/></Field>
                  <Field label="خلفية الشعار"><select name="logoBackgroundMode" className={styles['admin-select']} defaultValue={String(store.settings.branding?.logoBackgroundMode || 'with')}><option value="with">مع الخلفية</option><option value="without">بدون خلفية</option></select></Field>
                  <Field label="حذف الشعار الحالي"><span><input name="removeLogo" type="checkbox"/> حذف الشعار (عند عدم رفع شعار جديد)</span></Field>
                  <Field label="صورة الأيقونة الأولى HTTPS"><Input name="iconOneImageUrl" type="url" placeholder="https://..." defaultValue={String(store.settings.footer?.iconOneImageUrl || '')}/></Field>
                  <Field label="أو ارفع صورة الأيقونة الأولى"><Input name="iconOneFile" type="file" accept="image/jpeg,image/png,image/webp,image/gif,image/avif"/></Field>
                  <Field label="رابط الأيقونة الأولى"><Input name="iconOneLinkUrl" type="url" placeholder="https://..." defaultValue={String(store.settings.footer?.iconOneLinkUrl || '')}/></Field>
                  <Field label="صورة الأيقونة الثانية HTTPS"><Input name="iconTwoImageUrl" type="url" placeholder="https://..." defaultValue={String(store.settings.footer?.iconTwoImageUrl || '')}/></Field>
                  <Field label="أو ارفع صورة الأيقونة الثانية"><Input name="iconTwoFile" type="file" accept="image/jpeg,image/png,image/webp,image/gif,image/avif"/></Field>
                  <Field label="رابط الأيقونة الثانية"><Input name="iconTwoLinkUrl" type="url" placeholder="https://..." defaultValue={String(store.settings.footer?.iconTwoLinkUrl || '')}/></Field>
                  <div className={cn(styles['admin-actions'], styles.wide)}><Button type="submit" disabled={busy}>حفظ الإعدادات</Button></div>
                </form>
              </Panel>
              <Panel title="محتوى صفحات السياسات وخدمة العملاء" subtitle="اختَر الصفحة وعدّل نصها الذي يظهر في واجهة المتجر.">
                <form onSubmit={savePage}>
                  <Field label="الصفحة"><select className={styles['admin-select']} value={selectedPage} onChange={(event) => setSelectedPage(event.target.value)}>{PAGE_OPTIONS.map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></Field>
                  <Field label="محتوى الصفحة"><Textarea rows={9} maxLength={3500} value={pageContent} onChange={(event) => setPageContent(event.target.value)}/></Field>
                  <Button type="submit" disabled={busy || !pageContent.trim()}>حفظ محتوى الصفحة</Button>
                </form>
              </Panel>
              <Panel title="السلايدر والعروض" subtitle="أضف رابط صورة أو احذف صورة موجودة. الحد الأقصى 12 صورة.">
                <form onSubmit={addBanner} className={styles['admin-editor-grid']}>
                  <Field label="رابط الصورة HTTPS (اختياري عند رفع ملف)"><Input name="imageUrl" type="url" placeholder="https://..."/></Field>
                  <Field label="أو ارفع صورة من جهازك"><Input name="bannerFile" type="file" accept="image/jpeg,image/png,image/webp,image/gif,image/avif"/></Field>
                  <Field label="وصف الصورة"><Input name="alt" maxLength={160} placeholder="وصف العرض"/></Field>
                  <div className={cn(styles['admin-actions'], styles.wide)}><Button type="submit" disabled={busy}>إضافة صورة</Button></div>
                </form>
                <div className={styles['admin-banner-grid']} style={{ marginTop: 18 }}>
                  {store.banners.map((banner) => <div className={styles['admin-banner-card']} key={banner.id}>
                    <img src={banner.imageUrl} alt={banner.alt} onError={(event) => { event.currentTarget.style.opacity = '0.25'; }}/>
                    <div><span>{banner.alt}</span><Button kind="danger" onClick={() => { if (window.confirm('حذف صورة السلايدر؟')) void runAction({ action: 'delete-banner', id: banner.id }, 'store'); }}>حذف</Button></div>
                  </div>)}
                </div>
                {!store.banners.length ? <div className={styles['admin-empty']}>لا توجد صور سلايدر مسجلة بعد.</div> : null}
              </Panel>
            </>
          ) : null}

          {!loading && view === 'reviews' ? (
            <Panel title="تقييمات العملاء" subtitle="إظهار أو إخفاء التقييمات من المتجر أو حذفها.">
              <div className={styles['admin-section-list']}>
                {reviews.map((review) => <article key={review.id} className={styles['admin-review-card']}>
                  <div className={styles['admin-order-top']}><strong>{review.name || 'عميل'}</strong><span className={styles['admin-pill']}>{review.rating ? '★'.repeat(Math.max(0, Math.min(5, review.rating))) : 'بدون تقييم'}</span></div>
                  <p>{review.comment || '—'}</p>
                  <small className={styles['admin-muted']}>{formatDate(review.createdAt)} · الطلب {review.orderNumber || '—'}</small>
                  <div className={styles['admin-actions']}>
                    <Button kind="secondary" onClick={() => void runAction({ action: 'set-review-visibility', id: review.id, visible: review.visible === false }, 'reviews')}>{review.visible === false ? 'إظهار في المتجر' : 'إخفاء من المتجر'}</Button>
                    <Button kind="danger" onClick={() => { if (window.confirm('حذف هذا التقييم نهائيًا؟')) void runAction({ action: 'delete-review', id: review.id }, 'reviews'); }}>حذف التقييم</Button>
                  </div>
                </article>)}
                {!reviews.length ? <div className={styles['admin-empty']}>لا توجد تقييمات.</div> : null}
              </div>
            </Panel>
          ) : null}

          {!loading && view === 'admins' && isSuperAdmin ? (
            <>
              <Panel title="إنشاء حساب مدير" subtitle="الحسابات الإضافية بصلاحية مدير، أما حسابك الحالي فهو المدير الرئيسي.">
                <form onSubmit={submitAdmin} className={styles['admin-editor-grid']}>
                  <Field label="اسم المدير"><Input value={adminForm.name} onChange={(event) => setAdminForm({ ...adminForm, name: event.target.value })} placeholder="اسم المدير"/></Field>
                  <Field label="البريد الإلكتروني"><Input type="email" required value={adminForm.email} onChange={(event) => setAdminForm({ ...adminForm, email: event.target.value })}/></Field>
                  <Field label="كلمة المرور (10 أحرف على الأقل)"><Input type="password" required minLength={10} value={adminForm.password} onChange={(event) => setAdminForm({ ...adminForm, password: event.target.value })}/></Field>
                  <div className={cn(styles['admin-actions'], styles.wide)}><Button type="submit" disabled={busy}>إنشاء الحساب</Button></div>
                </form>
              </Panel>
              <Panel title="حسابات الإدارة">
                <div className={styles['admin-section-list']}>
                  {admins.map((admin) => <div className={styles['admin-section-row']} key={admin.id}>
                    <div><strong>{admin.name}</strong><br/><small className={styles['admin-muted']}>{admin.email} · {admin.role === 'super_admin' ? 'مدير رئيسي' : 'مدير'}</small></div>
                    <div className={styles['admin-actions']}>
                      <span className={cn(styles['admin-pill'], admin.active === false ? styles.danger : styles.success)}>{admin.active === false ? 'موقوف' : 'نشط'}</span>
                      {admin.role !== 'super_admin' ? <Button kind={admin.active === false ? 'secondary' : 'danger'} onClick={() => void runAction({ action: 'toggle-admin', id: admin.id, active: admin.active === false }, 'admins')}>{admin.active === false ? 'تفعيل' : 'إيقاف'}</Button> : null}
                    </div>
                  </div>)}
                </div>
              </Panel>
            </>
          ) : null}

          {!loading && view === 'security' ? (
            <Panel title="تغيير كلمة المرور" subtitle="يتم تخزين كلمة المرور كقيمة مشتقة ومملحة، وليس كنص صريح.">
              <form onSubmit={submitPassword} style={{ maxWidth: 520 }}>
                <Field label="كلمة المرور الحالية"><Input type="password" required autoComplete="current-password" value={securityForm.currentPassword} onChange={(event) => setSecurityForm({ ...securityForm, currentPassword: event.target.value })}/></Field>
                <Field label="كلمة المرور الجديدة (10 أحرف على الأقل)"><Input type="password" required minLength={10} autoComplete="new-password" value={securityForm.newPassword} onChange={(event) => setSecurityForm({ ...securityForm, newPassword: event.target.value })}/></Field>
                <Button type="submit" disabled={busy}>تغيير كلمة المرور</Button>
              </form>
            </Panel>
          ) : null}
        </div>
      </main>
    </div>
  );
}
