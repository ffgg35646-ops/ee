const SOURCE_HOSTS = new Set(["www.al-brag-ksa.store", "al-brag-ksa.store"]);
const MAX_HTML_BYTES = 4 * 1024 * 1024;
const MAX_IMAGES = 10;

type JsonRecord = Record<string, any>;

export type ImportedSourceProduct = {
  sourceProductUrl: string;
  sourceStore: "al-brag-ksa.store";
  name: string;
  price: number;
  oldPrice?: number;
  shortDescription: string;
  details: string;
  specifications: string[];
  images: string[];
  colors: string[];
  storageOptions: string[];
  storagePrices: Record<string, number>;
  sourceCategory: string;
  sourceBrand?: string;
  sourceSku?: string;
  sourceBarcode?: string;
};

function decodeHtml(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_match, code: string) => {
      const point = Number(code);
      return Number.isFinite(point) && point >= 0 && point <= 0x10ffff
        ? String.fromCodePoint(point)
        : "";
    })
    .replace(/&#x([\da-f]+);/gi, (_match, code: string) => {
      const point = Number.parseInt(code, 16);
      return Number.isFinite(point) && point >= 0 && point <= 0x10ffff
        ? String.fromCodePoint(point)
        : "";
    });
}

function stripHtml(value: unknown): string {
  if (typeof value !== "string") return "";
  return decodeHtml(
    value
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(?:p|div|li|tr|h[1-6])\s*>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/[\t\r ]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function readAttribute(tag: string, name: string): string {
  const escaped = name.replace(/[.*+?^{}()|[\]\\]/g, "\\$&");
  const match = tag.match(new RegExp("\\b" + escaped + "\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s>]+))", "i"));
  return decodeHtml(match?.[1] ?? match?.[2] ?? match?.[3] ?? "").trim();
}

function readMeta(html: string, key: string): string {
  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    const property = readAttribute(tag, "property") || readAttribute(tag, "name") || readAttribute(tag, "itemprop");
    if (property.toLowerCase() === key.toLowerCase()) {
      const content = readAttribute(tag, "content");
      if (content) return content;
    }
  }
  return "";
}

function readTagText(html: string, tagName: string): string {
  const match = html.match(new RegExp("<" + tagName + "\\b[^>]*>([\\s\\S]*?)<\\/" + tagName + ">", "i"));
  return stripHtml(match?.[1] || "");
}

function normalizeAmount(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  if (typeof value !== "string") return undefined;

  const normalized = value
    .replace(/[٠-٩]/g, (digit) => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)))
    .replace(/[۰-۹]/g, (digit) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(digit)))
    .replace(/[٬,\s]/g, "")
    .replace(/[^\d.]/g, "");
  const amount = Number(normalized);
  return Number.isFinite(amount) && amount > 0 ? amount : undefined;
}

function readPriceFromHtml(html: string): number | undefined {
  const tags = html.match(/<([a-z0-9]+)\b[^>]*(?:itemprop=["']price["']|class=["'][^"']*price[^"']*["'])[^>]*>/gi) || [];
  for (const tag of tags) {
    const direct = normalizeAmount(readAttribute(tag, "content") || readAttribute(tag, "data-price") || readAttribute(tag, "value"));
    if (direct) return direct;
    const tagName = tag.match(/^<([a-z0-9]+)/i)?.[1];
    if (!tagName) continue;
    const start = html.indexOf(tag) + tag.length;
    const close = html.toLowerCase().indexOf("</" + tagName.toLowerCase() + ">", start);
    if (close >= start) {
      const amount = normalizeAmount(stripHtml(html.slice(start, close)));
      if (amount) return amount;
    }
  }
  return undefined;
}

function walkObjects(value: unknown, output: JsonRecord[] = [], seen = new Set<object>()): JsonRecord[] {
  if (!value || typeof value !== "object" || seen.has(value as object)) return output;
  seen.add(value as object);
  if (!Array.isArray(value)) output.push(value as JsonRecord);
  if (Array.isArray(value)) {
    for (const item of value) walkObjects(item, output, seen);
  } else {
    for (const child of Object.values(value as JsonRecord)) walkObjects(child, output, seen);
  }
  return output;
}

function typeNames(value: unknown): string[] {
  return (Array.isArray(value) ? value : [value])
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.toLowerCase().split("/").pop() || item.toLowerCase());
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return stripHtml(value).slice(0, 5000);
  }
  return "";
}

function stringList(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [value];
  return values.flatMap((item) => {
    if (typeof item === "string" && item.trim()) return [item.trim()];
    if (item && typeof item === "object" && typeof (item as JsonRecord).url === "string") {
      return [(item as JsonRecord).url];
    }
    return [];
  });
}

function propertyPairs(value: unknown): Array<[string, string]> {
  const items = Array.isArray(value) ? value : value ? [value] : [];
  return items.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const row = item as JsonRecord;
    const name = firstString(row.name, row.propertyID);
    const propertyValue = firstString(row.value, row.valueReference?.name, row.valueReference);
    return name && propertyValue ? [[name, propertyValue] as [string, string]] : [];
  });
}

function findOffers(product: JsonRecord | undefined): JsonRecord[] {
  if (!product) return [];
  const raw = product.offers;
  return (Array.isArray(raw) ? raw : raw ? [raw] : [])
    .filter((offer): offer is JsonRecord => Boolean(offer && typeof offer === "object"));
}

function priceFromOffers(offers: JsonRecord[]): number | undefined {
  for (const offer of offers) {
    const direct = normalizeAmount(offer.price ?? offer.lowPrice);
    if (direct) return direct;
    const specifications = Array.isArray(offer.priceSpecification)
      ? offer.priceSpecification
      : offer.priceSpecification ? [offer.priceSpecification] : [];
    for (const specification of specifications) {
      if (specification && typeof specification === "object") {
        const amount = normalizeAmount((specification as JsonRecord).price);
        if (amount) return amount;
      }
    }
  }
  return undefined;
}

function addUnique(target: string[], value: string, limit = 30) {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (normalized && !target.some((item) => item.toLowerCase() === normalized.toLowerCase()) && target.length < limit) {
    target.push(normalized);
  }
}

function extractHtmlSpecs(html: string): string[] {
  const specs: string[] = [];
  for (const row of html.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi) || []) {
    const cells = [...row.matchAll(/<(?:th|td)\b[^>]*>([\s\S]*?)<\/(?:th|td)>/gi)]
      .map((match) => stripHtml(match[1]));
    if (cells.length >= 2 && cells[0] && cells[1]) addUnique(specs, cells[0] + ": " + cells.slice(1).join("، "), 40);
  }
  return specs;
}

function imageUrl(value: string, baseUrl: string): string {
  try {
    const url = new URL(value, baseUrl);
    if (url.protocol !== "https:" && url.protocol !== "http:") return "";
    if (url.username || url.password || url.hostname === "localhost") return "";
    return url.toString();
  } catch {
    return "";
  }
}

async function readLimitedBody(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (declaredLength > MAX_HTML_BYTES) {
    throw new Error("صفحة المنتج أكبر من الحد المسموح للاستيراد.");
  }
  if (!response.body) throw new Error("الموقع لم يُرجع محتوى صفحة المنتج.");

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_HTML_BYTES) {
      await reader.cancel();
      throw new Error("صفحة المنتج أكبر من الحد المسموح للاستيراد.");
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8").decode(bytes);
}

async function fetchProductHtml(initialUrl: URL): Promise<{ html: string; finalUrl: URL }> {
  let url = initialUrl;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await fetch(url, {
      method: "GET",
      redirect: "manual",
      cache: "no-store",
      headers: {
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "ar-SA,ar;q=0.9,en;q=0.7",
        "user-agent": "Mozilla/5.0 (compatible; EEProductImporter/1.0; +https://www.al-brag-ksa.store)"
      },
      signal: AbortSignal.timeout(18_000)
    });

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location || attempt === 3) throw new Error("تعذر تتبع تحويل صفحة المنتج.");
      const nextUrl = new URL(location, url);
      if (!SOURCE_HOSTS.has(nextUrl.hostname.toLowerCase()) || nextUrl.protocol !== "https:") {
        throw new Error("الموقع حوّل رابط المنتج إلى نطاق غير معتمد.");
      }
      url = nextUrl;
      continue;
    }

    if (!response.ok) {
      if (response.status === 403 || response.status === 429) {
        throw new Error("الموقع منع طلب الاستيراد أو طلب تحققًا إضافيًا. جرّب لاحقًا أو أرسل بيانات المنتج يدويًا.");
      }
      throw new Error("تعذر فتح صفحة المنتج. كود الاستجابة: " + response.status);
    }

    const contentType = (response.headers.get("content-type") || "").toLowerCase();
    if (contentType && !contentType.includes("text/html") && !contentType.includes("application/xhtml")) {
      throw new Error("الرابط لا يعرض صفحة منتج HTML قابلة للاستيراد.");
    }
    return { html: await readLimitedBody(response), finalUrl: url };
  }

  throw new Error("تعذر فتح صفحة المنتج بعد التحويل.");
}

export async function importAlBragProduct(rawUrl: string): Promise<ImportedSourceProduct> {
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    throw new Error("أرسل رابط منتج صحيحًا يبدأ بـ https://www.al-brag-ksa.store/");
  }

  if (
    url.protocol !== "https:"
    || !SOURCE_HOSTS.has(url.hostname.toLowerCase())
    || !/^\/product2\/\d+\/?$/.test(url.pathname)
    || url.username
    || url.password
  ) {
    throw new Error("الاستيراد متاح حاليًا لروابط المنتجات من al-brag-ksa.store فقط، بصيغة /product2/رقم.");
  }

  url.hash = "";
  url.search = "";
  const { html, finalUrl } = await fetchProductHtml(url);
  finalUrl.hash = "";
  finalUrl.search = "";
  finalUrl.pathname = finalUrl.pathname.replace(/\/+$/, "");
  const jsonLdNodes: JsonRecord[] = [];
  for (const match of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      jsonLdNodes.push(...walkObjects(JSON.parse(match[1])));
    } catch {
      // Invalid or partial structured data is ignored; meta tags remain a fallback.
    }
  }

  const product = jsonLdNodes.find((node) =>
    typeNames(node["@type"]).some((name) => name === "product" || name === "productgroup")
  );
  const variants = product && Array.isArray(product.hasVariant)
    ? product.hasVariant.filter((item: unknown): item is JsonRecord => Boolean(item && typeof item === "object"))
    : [];
  const offers = findOffers(product);
  const firstVariantOffers = variants.flatMap((variant) => findOffers(variant));
  const title = firstString(
    product?.name,
    readMeta(html, "og:title"),
    readMeta(html, "twitter:title"),
    readTagText(html, "h1"),
    readTagText(html, "title")
  );
  const description = firstString(
    product?.description,
    readMeta(html, "description"),
    readMeta(html, "og:description"),
    readMeta(html, "twitter:description")
  );

  const price = priceFromOffers(offers)
    ?? priceFromOffers(firstVariantOffers)
    ?? normalizeAmount(readMeta(html, "product:price:amount"))
    ?? normalizeAmount(readMeta(html, "og:price:amount"))
    ?? readPriceFromHtml(html);
  const oldPrice = normalizeAmount(readMeta(html, "product:price:standard_amount"))
    ?? normalizeAmount(readMeta(html, "product:price:original_amount"))
    ?? normalizeAmount(readMeta(html, "product:price:old_amount"));

  if (!title) {
    throw new Error("تم فتح الموقع، لكن لم أستطع استخراج اسم المنتج من الصفحة.");
  }
  if (!price) {
    throw new Error("تم العثور على صفحة المنتج، لكن لم أستطع استخراج سعر رقمي موثوق منها؛ لم يتم حفظ أي بيانات.");
  }

  const images: string[] = [];
  const galleryImageCandidates = (html.match(/<img\b[^>]*>/gi) || []).flatMap((tag) => {
    const context = (readAttribute(tag, "class") + " " + readAttribute(tag, "id") + " " + readAttribute(tag, "alt")).toLowerCase();
    if (!/product|gallery|zoom|detail|main-image|صورة المنتج/.test(context)) return [];
    const srcset = readAttribute(tag, "srcset").split(",")[0]?.trim().split(/\s+/)[0] || "";
    return [
      readAttribute(tag, "data-large_image"),
      readAttribute(tag, "data-zoom-image"),
      readAttribute(tag, "data-src"),
      readAttribute(tag, "data-original"),
      srcset,
      readAttribute(tag, "src")
    ].filter(Boolean);
  });
  for (const candidate of [
    ...stringList(product?.image),
    readMeta(html, "og:image"),
    readMeta(html, "twitter:image"),
    ...galleryImageCandidates
  ]) {
    const resolved = imageUrl(candidate, finalUrl.toString());
    if (resolved) addUnique(images, resolved, MAX_IMAGES);
  }

  const colors: string[] = [];
  const storageOptions: string[] = [];
  const storagePrices: Record<string, number> = {};
  for (const [name, value] of propertyPairs(product?.additionalProperty)) {
    if (/color|colour|لون/i.test(name)) addUnique(colors, value);
    if (/storage|capacity|memory|سعة|تخزين|مساحة/i.test(name) || /\b(?:\d{2,4}\s?(?:gb|tb)|\d(?:\.\d)?\s?tb)\b/i.test(value)) {
      addUnique(storageOptions, value);
    }
  }
  if (typeof product?.color === "string") addUnique(colors, product.color);
  for (const variant of variants) {
    const variantPairs = propertyPairs(variant.additionalProperty);
    const color = firstString(
      variant.color,
      ...variantPairs.filter(([name]) => /color|colour|لون/i.test(name)).map(([, value]) => value)
    );
    const storage = firstString(
      variant.size,
      ...variantPairs.filter(([name]) => /storage|capacity|memory|سعة|تخزين|مساحة/i.test(name)).map(([, value]) => value)
    );
    if (color) addUnique(colors, color);
    if (storage) {
      addUnique(storageOptions, storage);
      const variantPrice = priceFromOffers(findOffers(variant));
      if (variantPrice && !storagePrices[storage]) storagePrices[storage] = variantPrice;
    }
  }

  const specifications: string[] = [];
  for (const [name, value] of propertyPairs(product?.additionalProperty)) {
    addUnique(specifications, name + ": " + value, 40);
  }
  for (const specification of extractHtmlSpecs(html)) addUnique(specifications, specification, 40);

  const breadcrumb = jsonLdNodes.find((node) => typeNames(node["@type"]).includes("breadcrumblist"));
  const breadcrumbItems = Array.isArray(breadcrumb?.itemListElement) ? breadcrumb.itemListElement : [];
  const breadcrumbNames = breadcrumbItems
    .map((item: JsonRecord) => firstString(item.name, item.item?.name, item.item))
    .filter(Boolean);
  const sourceCategory = firstString(
    product?.category,
    breadcrumbNames.length > 1 ? breadcrumbNames[breadcrumbNames.length - 2] : "",
    readMeta(html, "article:section")
  ).slice(0, 120) || "منتجات مستوردة";

  const brand = firstString(product?.brand?.name, product?.brand);
  const sku = firstString(product?.sku, product?.mpn);
  const barcode = firstString(product?.gtin13, product?.gtin12, product?.gtin14, product?.gtin);
  if (brand) addUnique(specifications, "الماركة: " + brand, 40);
  if (sku) addUnique(specifications, "رمز المنتج: " + sku, 40);
  if (barcode) addUnique(specifications, "الباركود: " + barcode, 40);

  const details = [
    description,
    specifications.length ? "مواصفات المنتج:\n" + specifications.join("\n") : ""
  ].filter(Boolean).join("\n\n").slice(0, 3000);
  const shortDescription = (description || specifications.slice(0, 3).join("، ") || title).slice(0, 300);

  return {
    sourceProductUrl: finalUrl.toString(),
    sourceStore: "al-brag-ksa.store",
    name: title.slice(0, 120),
    price,
    ...(oldPrice && oldPrice > price ? { oldPrice } : {}),
    shortDescription,
    details: details || shortDescription,
    specifications,
    images,
    colors,
    storageOptions,
    storagePrices,
    sourceCategory,
    ...(brand ? { sourceBrand: brand.slice(0, 120) } : {}),
    ...(sku ? { sourceSku: sku.slice(0, 100) } : {}),
    ...(barcode ? { sourceBarcode: barcode.slice(0, 80) } : {})
  };
}


type SourceDiscoveryResult = {
  urls: string[];
  scannedSitemaps: number;
  scannedPages: number;
  warnings: string[];
};

async function fetchSourceDocument(value: string): Promise<{ text: string; url: URL }> {
  let url = new URL(value);
  if (url.protocol !== "https:" || !SOURCE_HOSTS.has(url.hostname.toLowerCase()) || url.username || url.password) {
    throw new Error("رابط ملف المصدر خارج النطاق المسموح.");
  }

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await fetch(url, {
      method: "GET",
      redirect: "manual",
      cache: "no-store",
      headers: {
        accept: "application/xml,text/xml,text/plain,text/html;q=0.9,*/*;q=0.8",
        "accept-language": "ar-SA,ar;q=0.9,en;q=0.7",
        "user-agent": "Mozilla/5.0 (compatible; EEProductCatalogDiscovery/1.0)"
      },
      signal: AbortSignal.timeout(18_000)
    });

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location || attempt === 3) throw new Error("تعذر تتبع تحويل ملف المصدر.");
      const nextUrl = new URL(location, url);
      if (nextUrl.protocol !== "https:" || !SOURCE_HOSTS.has(nextUrl.hostname.toLowerCase())) {
        throw new Error("ملف المصدر يحوّل إلى نطاق غير معتمد.");
      }
      url = nextUrl;
      continue;
    }

    if (!response.ok) throw new Error("HTTP " + response.status + " عند قراءة " + url.pathname);
    return { text: await readLimitedBody(response), url };
  }
  throw new Error("تعذر قراءة ملف المصدر.");
}

function normalizeSourceUrl(value: string, base: URL): string {
  const candidate = value.trim().replace(/^<!\[CDATA\[|\]\]>$/g, "");
  if (!candidate) return "";
  try {
    const url = new URL(decodeHtml(candidate), base);
    if (
      url.protocol !== "https:"
      || !SOURCE_HOSTS.has(url.hostname.toLowerCase())
      || url.username
      || url.password
      || !/^\/product2\/\d+\/?$/i.test(url.pathname)
    ) return "";
    url.hash = "";
    url.search = "";
    url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString();
  } catch {
    return "";
  }
}

function collectProductLinks(document: string, pageUrl: URL): string[] {
  const found = new Set<string>();
  for (const match of document.matchAll(/<loc\b[^>]*>([\s\S]*?)<\/loc>/gi)) {
    const url = normalizeSourceUrl(stripHtml(match[1]), pageUrl);
    if (url) found.add(url);
  }
  for (const tag of document.match(/<a\b[^>]*>/gi) || []) {
    const href = readAttribute(tag, "href");
    const url = normalizeSourceUrl(href, pageUrl);
    if (url) found.add(url);
  }
  for (const match of document.matchAll(/https?:\/\/(?:www\.)?al-brag-ksa\.store\/product2\/\d+\/?/gi)) {
    const url = normalizeSourceUrl(match[0], pageUrl);
    if (url) found.add(url);
  }
  for (const match of document.matchAll(/\/product2\/\d+\/?/gi)) {
    const url = normalizeSourceUrl(match[0], pageUrl);
    if (url) found.add(url);
  }
  return [...found];
}

export async function discoverAlBragProductUrls(): Promise<SourceDiscoveryResult> {
  const origin = "https://www.al-brag-ksa.store";
  const warnings: string[] = [];
  const sitemapQueue = new Set<string>([
    origin + "/sitemap.xml",
    origin + "/sitemap_index.xml",
    origin + "/sitemap-index.xml",
    origin + "/sitemap_products.xml",
    origin + "/product-sitemap.xml"
  ]);
  const visitedSitemaps = new Set<string>();
  const productUrls = new Set<string>();
  let scannedSitemaps = 0;
  let scannedPages = 0;

  try {
    const robots = await fetchSourceDocument(origin + "/robots.txt");
    for (const line of robots.text.split(/\r?\n/)) {
      const match = line.match(/^\s*sitemap:\s*(\S+)/i);
      if (!match) continue;
      try {
        const sitemapUrl = new URL(match[1], robots.url);
        if (sitemapUrl.protocol === "https:" && SOURCE_HOSTS.has(sitemapUrl.hostname.toLowerCase())) {
          sitemapQueue.add(sitemapUrl.toString());
        }
      } catch {
        // Ignore malformed sitemap declarations.
      }
    }
  } catch (error) {
    warnings.push("تعذر قراءة robots.txt: " + (error instanceof Error ? error.message : "خطأ غير معروف"));
  }

  while (sitemapQueue.size && visitedSitemaps.size < 30) {
    const sitemapUrl = sitemapQueue.values().next().value as string;
    sitemapQueue.delete(sitemapUrl);
    if (visitedSitemaps.has(sitemapUrl)) continue;
    visitedSitemaps.add(sitemapUrl);

    try {
      const document = await fetchSourceDocument(sitemapUrl);
      scannedSitemaps += 1;
      for (const productUrl of collectProductLinks(document.text, document.url)) {
        productUrls.add(productUrl);
      }

      for (const match of document.text.matchAll(/<loc\b[^>]*>([\s\S]*?)<\/loc>/gi)) {
        const rawLocation = decodeHtml(stripHtml(match[1]));
        try {
          const child = new URL(rawLocation, document.url);
          if (
            child.protocol === "https:"
            && SOURCE_HOSTS.has(child.hostname.toLowerCase())
            && /\.xml(?:\.gz)?(?:$|\?)/i.test(child.pathname)
            && !visitedSitemaps.has(child.toString())
            && visitedSitemaps.size + sitemapQueue.size < 30
          ) {
            sitemapQueue.add(child.toString());
          } else if (
            child.protocol === "https:"
            && SOURCE_HOSTS.has(child.hostname.toLowerCase())
            && !/^\/product2\/\d+\/?$/i.test(child.pathname)
            && productUrls.size < 1
            && scannedPages < 8
          ) {
            // Category/page URLs in some sitemap formats are used below as a fallback.
          }
        } catch {
          // Ignore malformed sitemap entries.
        }
      }
    } catch (error) {
      warnings.push("تعذرت قراءة " + new URL(sitemapUrl).pathname + ": " + (error instanceof Error ? error.message : "خطأ غير معروف"));
    }
  }

  if (!productUrls.size) {
    const pageQueue = new Set<string>([origin + "/"]);
    while (pageQueue.size && scannedPages < 8 && productUrls.size < 1000) {
      const pageUrl = pageQueue.values().next().value as string;
      pageQueue.delete(pageUrl);
      try {
        const page = await fetchSourceDocument(pageUrl);
        scannedPages += 1;
        for (const productUrl of collectProductLinks(page.text, page.url)) productUrls.add(productUrl);

        if (scannedPages === 1) {
          for (const tag of page.text.match(/<a\b[^>]*>/gi) || []) {
            const href = readAttribute(tag, "href");
            if (!href) continue;
            try {
              const child = new URL(href, page.url);
              if (
                child.protocol === "https:"
                && SOURCE_HOSTS.has(child.hostname.toLowerCase())
                && !/^\/product2\/\d+\/?$/i.test(child.pathname)
                && !/\/(?:admin|account|cart|checkout|login|register|privacy|terms)(?:\/|$)/i.test(child.pathname)
                && pageQueue.size < 7
              ) pageQueue.add(child.toString());
            } catch {
              // Ignore malformed links.
            }
          }
        }
      } catch (error) {
        warnings.push("تعذرت قراءة صفحة " + pageUrl + ": " + (error instanceof Error ? error.message : "خطأ غير معروف"));
      }
    }
  }

  const urls = [...productUrls].sort((a, b) => {
    const left = Number(a.match(/\/product2\/(\d+)/i)?.[1] || 0);
    const right = Number(b.match(/\/product2\/(\d+)/i)?.[1] || 0);
    return left - right;
  });

  if (!urls.length) {
    warnings.push("لم يتم العثور على روابط /product2/{id} في خرائط الموقع أو الصفحات العامة.");
  }

  return { urls, scannedSitemaps, scannedPages, warnings };
}

/**
 * Discover only the products exposed by a specific al-brag catalog category.
 * Pagination links are followed conservatively and the optional supplied
 * product URL is included explicitly, even if the category page lazy-loads it.
 */
export async function discoverAlBragCategoryProductUrls(
  rawCategoryUrl: string,
  sampleProductUrl = ""
): Promise<SourceDiscoveryResult & { categoryOverride: string }> {
  let categoryUrl: URL;
  try {
    categoryUrl = new URL(rawCategoryUrl.trim());
  } catch {
    throw new Error("أدخل رابط قسم صحيحًا من موقع البرق المضيء.");
  }

  if (
    categoryUrl.protocol !== "https:"
    || !SOURCE_HOSTS.has(categoryUrl.hostname.toLowerCase())
    || categoryUrl.pathname.replace(/\\/+$/, "") !== "/catalog"
    || categoryUrl.username
    || categoryUrl.password
  ) {
    throw new Error("رابط القسم يجب أن يكون من al-brag-ksa.store وبمسار /catalog.");
  }

  const categorySlug = (categoryUrl.searchParams.get("category") || "").trim();
  if (!categorySlug) throw new Error("رابط القسم لا يحتوي على category.");
  categoryUrl.hash = "";
  const categoryOverride = decodeURIComponent(categorySlug.replace(/\\+/g, " "))
    .replace(/[-_]+/g, " ")
    .replace(/\\s+/g, " ")
    .trim()
    .slice(0, 120);
  if (!categoryOverride) throw new Error("تعذر تحديد اسم القسم من الرابط.");

  const warnings: string[] = [];
  const pages = new Set<string>([categoryUrl.toString()]);
  const visited = new Set<string>();
  const productUrls = new Set<string>();
  let scannedPages = 0;

  const suppliedProductUrl = sampleProductUrl.trim();
  if (suppliedProductUrl) {
    const normalized = normalizeSourceUrl(suppliedProductUrl, categoryUrl);
    if (!normalized) throw new Error("رابط المنتج الإضافي يجب أن يكون بصيغة /product2/رقم من الموقع نفسه.");
    productUrls.add(normalized);
  }

  while (pages.size && visited.size < 30 && productUrls.size < 2000) {
    const pageUrlText = pages.values().next().value as string;
    pages.delete(pageUrlText);
    if (visited.has(pageUrlText)) continue;
    visited.add(pageUrlText);

    try {
      const page = await fetchSourceDocument(pageUrlText);
      scannedPages += 1;
      for (const productUrl of collectProductLinks(page.text, page.url)) productUrls.add(productUrl);

      for (const tag of page.text.match(/<a\\b[^>]*>/gi) || []) {
        const href = readAttribute(tag, "href");
        if (!href) continue;
        try {
          const candidate = new URL(href, page.url);
          if (
            candidate.protocol !== "https:"
            || !SOURCE_HOSTS.has(candidate.hostname.toLowerCase())
            || candidate.pathname.replace(/\\/+$/, "") !== "/catalog"
            || candidate.searchParams.get("category") !== categorySlug
          ) continue;

          const rel = readAttribute(tag, "rel").toLowerCase();
          const className = (readAttribute(tag, "class") + " " + readAttribute(tag, "aria-label")).toLowerCase();
          const hasPageParameter = ["page", "p", "paged", "pageNumber", "page_number"]
            .some((key) => candidate.searchParams.has(key));
          const isNextLink = /next|التالي|pagination|page-link/.test(rel + " " + className);
          if (!hasPageParameter && !isNextLink) continue;

          candidate.hash = "";
          const nextPage = candidate.toString();
          if (!visited.has(nextPage) && pages.size + visited.size < 30) pages.add(nextPage);
        } catch {
          // Ignore malformed or external pagination links.
        }
      }
    } catch (error) {
      warnings.push("تعذر قراءة صفحة القسم " + pageUrlText + ": " + (error instanceof Error ? error.message : "خطأ غير معروف"));
    }
  }

  const urls = [...productUrls].sort((a, b) => {
    const left = Number(a.match(/\\/product2\\/(\\d+)/i)?.[1] || 0);
    const right = Number(b.match(/\\/product2\\/(\\d+)/i)?.[1] || 0);
    return left - right;
  }).slice(0, 2000);

  if (!urls.length) {
    warnings.push("لم يتم العثور على روابط منتجات في صفحة القسم. قد يكون الموقع يعرض المنتجات عبر JavaScript أو يتطلب تحققًا إضافيًا.");
  }

  return { urls, scannedSitemaps: 0, scannedPages, warnings, categoryOverride };
}
