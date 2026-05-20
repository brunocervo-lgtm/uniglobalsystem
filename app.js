const money = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const today = new Date().toISOString().slice(0, 10);
const DB_KEY = "uniglobal-stock-ai-v1";
const AUTH_KEY = "uniglobal-stock-ai-user";
const OPENAI_KEY = "uniglobal-stock-ai-openai-key";
const SUPABASE_URL = "https://favsnuzncijpiwyewdli.supabase.co";
const SUPABASE_KEY = "sb_publishable_OP0CD--P7EQSuDU6_BvEog_eglwjiJv";
const CLOUD_STATE_ID = "state";
const CLOUD_PARTS = ["items", "pendingItems", "sales", "invoices", "receivables", "contacts", "users", "sequence", "cloudUpdatedAt"];
const APP_VERSION = "20260520-1210";

const DEFAULT_USERS = [
  { id: "default-admin", username: "admin", password: "uniglobal123", role: "admin" },
  { id: "default-colaborador", username: "colaborador", password: "123456", role: "colaborador" }
];

if (new URLSearchParams(location.search).get("reset") === "all") {
  const blank = { items: [], pendingItems: [], sales: [], invoices: [], receivables: [], contacts: [], users: DEFAULT_USERS, sequence: 1 };
  localStorage.setItem(DB_KEY, JSON.stringify(blank));
  sessionStorage.removeItem(AUTH_KEY);
}

const views = {
  dashboard: "Dashboard",
  estoque: "Estoque",
  cadastro: "Cadastro de item",
  contatos: "Cliente / Fornecedor",
  vendedores: "Vendedores",
  alerta: "Alerta",
  sucata: "Sucata por peso",
  venda: "Saida / Venda",
  contasReceber: "Contas a receber",
  inventarioVendas: "Inventario de produtos",
  relatorios: "Relatorios",
  configuracao: "Configuracao"
};

const adminViews = ["dashboard", "estoque", "cadastro", "contatos", "vendedores", "alerta", "sucata", "venda", "contasReceber", "inventarioVendas", "relatorios", "configuracao"];
const collaboratorViews = ["cadastro"];
const state = migrate(load());
let activeProduct = null;
let editingContactId = "";
let activeContactId = "";
let editingUserId = "";
let activeSaleId = "";
let activeDashboardTab = "principal";
let activeReportTab = "principal";
let editingSaleId = "";
let cloudSaveTimer = null;
let cloudLastError = "";
let saleCart = [];

function activeKey() {
  return DB_KEY;
}

function blankState(users = DEFAULT_USERS) {
  return { items: [], pendingItems: [], sales: [], invoices: [], receivables: [], contacts: [], users, sequence: 1 };
}

function load() {
  try { return JSON.parse(localStorage.getItem(activeKey())) || blankState(); }
  catch { return blankState(); }
}

function migrate(data) {
  data.items ||= [];
  data.pendingItems ||= [];
  data.sales ||= [];
  data.invoices ||= [];
  data.receivables ||= [];
  data.contacts ||= [];
  data.sequence ||= 1;
  data.cloudUpdatedAt ||= "";
  data.users = Array.isArray(data.users) && data.users.length ? data.users : DEFAULT_USERS;
  data.items.forEach(item => stampCreate(item));
  data.pendingItems.forEach(item => stampCreate(item));
  data.sales.forEach(sale => stampCreate(sale));
  data.invoices.forEach(invoice => stampCreate(invoice));
  data.receivables.forEach(receivable => stampCreate(receivable));
  data.contacts.forEach(contact => stampCreate(contact));
  data.users.forEach(user => stampCreate(user));
  return data;
}

function save(options = {}) {
  if (!options.skipTimestamp) state.cloudUpdatedAt = new Date().toISOString();
  localStorage.setItem(activeKey(), JSON.stringify(state));
  if (!options.skipRender) render();
  queueCloudSave();
}

function cloudEnabled() {
  return SUPABASE_URL && SUPABASE_KEY;
}

async function supabaseRequest(path, options = {}) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Supabase retornou ${response.status}`);
  }
  if (response.status === 204) return null;
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

function applyCloudState(data) {
  const next = migrate(data || blankState());
  Object.keys(state).forEach(key => delete state[key]);
  Object.assign(state, next);
  localStorage.setItem(DB_KEY, JSON.stringify(state));
}

function stateHasBusinessData(data = state) {
  return ["items", "pendingItems", "sales", "invoices", "receivables", "contacts"].some(key => Array.isArray(data[key]) && data[key].length);
}

function stateTime(data = {}) {
  return new Date(data.cloudUpdatedAt || data.updatedAt || data.createdAt || 0).getTime() || 0;
}

function cloudPartsFilter() {
  return `id=in.(${CLOUD_PARTS.join(",")})`;
}

function stateFromCloudRows(rows = []) {
  const next = blankState();
  rows.forEach(row => {
    if (!CLOUD_PARTS.includes(row.id)) return;
    next[row.id] = row.value?.data ?? row.value;
  });
  return migrate(next);
}

async function readCloudParts() {
  const data = await supabaseRequest("rpc/load_uniglobal_state_v2", {
    method: "POST",
    body: JSON.stringify({})
  });
  return migrate({ ...blankState(), ...(data || {}) });
}

async function loadCloudState() {
  if (!cloudEnabled()) return false;
  const localSnapshot = JSON.parse(localStorage.getItem(DB_KEY) || "null");
  const localState = migrate(localSnapshot || blankState());
  try {
    const nextCloudState = await readCloudParts();
    if (stateHasBusinessData(nextCloudState) || stateTime(nextCloudState)) {
      const cloudIsNewer = stateTime(nextCloudState) > stateTime(state);
      const localIsNewer = stateTime(localState) > stateTime(nextCloudState);
      if (localIsNewer && stateHasBusinessData(localState)) {
        applyCloudState(localState);
        await saveCloudStateNow();
      } else if ((stateHasBusinessData(nextCloudState) && cloudIsNewer) || !stateHasBusinessData(state)) {
        applyCloudState(nextCloudState);
      } else {
        await saveCloudStateNow();
      }
      cloudLastError = "";
      return true;
    }
    const rows = await supabaseRequest(`app_settings?id=eq.${encodeURIComponent(CLOUD_STATE_ID)}&select=value`);
    if (rows?.[0]?.value) {
      const cloudState = migrate(rows[0].value);
      const cloudIsNewer = stateTime(cloudState) > stateTime(state);
      if ((stateHasBusinessData(cloudState) && cloudIsNewer) || !stateHasBusinessData(state)) {
        applyCloudState(cloudState);
      } else {
        await saveCloudStateNow();
      }
      cloudLastError = "";
      return true;
    }
    await saveCloudStateNow();
    cloudLastError = "";
    return true;
  } catch (error) {
    cloudLastError = error.message;
    console.warn("Falha ao carregar Supabase:", error);
    return false;
  }
}

async function saveCloudStateNow() {
  if (!cloudEnabled()) return;
  state.cloudUpdatedAt = new Date().toISOString();
  localStorage.setItem(activeKey(), JSON.stringify(state));
  const payload = {};
  CLOUD_PARTS.forEach(part => {
    payload[part] = state[part];
  });
  return supabaseRequest("rpc/save_uniglobal_state_v2", {
    method: "POST",
    body: JSON.stringify({ payload })
  });
}

function queueCloudSave() {
  if (!cloudEnabled()) return;
  clearTimeout(cloudSaveTimer);
  cloudSaveTimer = setTimeout(async () => {
    try {
      await saveCloudStateNow();
      cloudLastError = "";
    } catch (error) {
      cloudLastError = error.message;
      console.warn("Falha ao salvar Supabase:", error);
      toast("Salvo localmente. Falha ao sincronizar online.");
    }
  }, 500);
}

function updateCloudStatus(message) {
  const el = document.querySelector("#cloudStatus");
  if (el) el.innerHTML = `${message}<span>Versao do app: ${APP_VERSION}</span>`;
}

function cloudStateSummary(data = state) {
  return `${data.items.length} produtos, ${data.pendingItems.length} pendentes, ${data.contacts.length} cadastros, ${data.sales.length} vendas, ${data.receivables?.length || 0} contas`;
}

async function syncCloudNow(showToast = true) {
  try {
    await saveCloudStateNow();
    const savedState = await readCloudParts();
    if (stateTime(savedState) < stateTime(state) || cloudStateSummary(savedState) !== cloudStateSummary(state)) {
      throw new Error(`Supabase nao confirmou os dados enviados. Enviado: ${cloudStateSummary(state)}. Retornou: ${cloudStateSummary(savedState)}.`);
    }
    cloudLastError = "";
    updateCloudStatus(`<strong>Status: sincronizado online</strong><span>${cloudStateSummary()} - ${new Date().toLocaleString("pt-BR")}</span>`);
    if (showToast) toast("Banco online sincronizado");
    return true;
  } catch (error) {
    cloudLastError = error.message;
    updateCloudStatus(`<strong>Status: erro ao sincronizar</strong><span>${escapeHtml(error.message)}</span>`);
    if (showToast) toast("Erro ao sincronizar online");
    return false;
  }
}

function getCurrentUser() {
  const username = sessionStorage.getItem(AUTH_KEY);
  return state.users.find(user => user.username === username) || null;
}

function isAdmin() {
  return getCurrentUser()?.role === "admin";
}

function currentUsername() {
  try {
    return getCurrentUser()?.username || sessionStorage.getItem(AUTH_KEY) || "sistema";
  } catch {
    return sessionStorage.getItem(AUTH_KEY) || "sistema";
  }
}

function stampCreate(target) {
  const now = new Date().toISOString();
  target.createdAt ||= now;
  target.createdBy ||= currentUsername();
  target.updatedAt ||= "";
  target.updatedBy ||= "";
  return target;
}

function stampUpdate(target) {
  target.updatedAt = new Date().toISOString();
  target.updatedBy = currentUsername();
  return target;
}

function auditLine(record = {}) {
  const created = record.createdAt ? new Date(record.createdAt).toLocaleString("pt-BR") : "-";
  const updated = record.updatedAt ? new Date(record.updatedAt).toLocaleString("pt-BR") : "-";
  return `Criado por ${record.createdBy || "-"} em ${created}${record.updatedBy ? ` | Editado por ${record.updatedBy} em ${updated}` : ""}`;
}

function allowedViews() {
  return isAdmin() ? adminViews : collaboratorViews;
}

function code() {
  return `UNI-${String(state.sequence).padStart(4, "0")}`;
}

function num(value) {
  return Number(value || 0);
}

function daysSince(date) {
  return Math.floor((Date.now() - new Date(date || today).getTime()) / 86400000);
}

function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[char]));
}

function toast(message) {
  const el = document.querySelector("#toast");
  el.textContent = message;
  el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 2200);
}

function lockApp() {
  document.body.classList.add("auth-locked");
  document.querySelector("#loginForm").reset();
  document.querySelector("#loginError").textContent = "";
  setTimeout(() => document.querySelector("input[name='username']")?.focus(), 50);
}

function unlockApp() {
  document.body.classList.remove("auth-locked");
  applyPermissions();
  render();
  switchView(isAdmin() ? "dashboard" : "cadastro");
}

function fileToDataURL(file) {
  return new Promise((resolve) => {
    if (!file) return resolve("");
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.readAsDataURL(file);
  });
}

function imageFromFile(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

function loadExternalScript(src, globalName) {
  return new Promise((resolve, reject) => {
    if (globalName && window[globalName]) return resolve(window[globalName]);
    const existing = document.querySelector(`script[data-src="${src}"]`);
    if (existing) {
      existing.addEventListener("load", () => resolve(globalName ? window[globalName] : true), { once: true });
      existing.addEventListener("error", () => reject(new Error("Nao foi possivel carregar o leitor de codigo de barras.")), { once: true });
      return;
    }
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.dataset.src = src;
    script.onload = () => resolve(globalName ? window[globalName] : true);
    script.onerror = () => reject(new Error("Nao foi possivel carregar o leitor de codigo de barras."));
    document.head.appendChild(script);
  });
}

async function readBarcodeWithNativeDetector(file) {
  if (!("BarcodeDetector" in window)) return "";
  const formats = ["ean_13", "ean_8", "upc_a", "upc_e", "code_128"];
  const supported = await BarcodeDetector.getSupportedFormats?.() || formats;
  const activeFormats = formats.filter(format => supported.includes(format));
  if (!activeFormats.length) return "";
  const detector = new BarcodeDetector({ formats: activeFormats });
  const image = await imageFromFile(file);
  try {
    const barcodes = await detector.detect(image);
    return barcodes.find(item => item.rawValue)?.rawValue || "";
  } finally {
    URL.revokeObjectURL(image.src);
  }
}

async function readBarcodeWithHtml5QrCode(file) {
  await loadExternalScript("https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js", "Html5Qrcode");
  let holder = document.querySelector("#eanReaderHolder");
  if (!holder) {
    holder = document.createElement("div");
    holder.id = "eanReaderHolder";
    holder.style.display = "none";
    document.body.appendChild(holder);
  }
  const scanner = new Html5Qrcode("eanReaderHolder", { verbose: false });
  try {
    return await scanner.scanFile(file, false);
  } finally {
    try { await scanner.clear(); } catch {}
  }
}

async function readBarcodeFromImage(file) {
  let code = "";
  try { code = await readBarcodeWithNativeDetector(file); } catch {}
  if (!code) {
    try { code = await readBarcodeWithHtml5QrCode(file); } catch (error) {
      throw new Error(`${error.message} Digite o EAN manualmente ou tente uma foto mais nÃ­tida do codigo.`);
    }
  }
  if (!code) throw new Error("Nao encontrei codigo de barras na foto. Tente aproximar, focar melhor e deixar o EAN inteiro visivel.");
  return code.replace(/\D/g, "");
}

function marketLinks(query) {
  const q = encodeURIComponent(query.trim());
  return [
    ["Mercado Livre", `https://lista.mercadolivre.com.br/${q}`],
    ["OLX", `https://www.olx.com.br/brasil?q=${q}`],
    ["Amazon", `https://www.amazon.com.br/s?k=${q}`],
    ["Shopee", `https://shopee.com.br/search?keyword=${q}`],
    ["Google", `https://www.google.com/search?q=${q}+preco+usado`]
  ];
}

async function fetchMercadoLivrePrices(query) {
  const url = `https://api.mercadolibre.com/sites/MLB/search?q=${encodeURIComponent(query)}&limit=20`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Mercado Livre retornou ${response.status}`);
  const data = await response.json();
  const results = (data.results || [])
    .filter(item => Number(item.price) > 0)
    .map(item => ({
      title: item.title,
      price: Number(item.price),
      link: item.permalink
    }));
  if (!results.length) throw new Error("Nenhum preÃ§o encontrado no Mercado Livre");
  const prices = results.map(item => item.price).sort((a, b) => a - b);
  const average = prices.reduce((sum, price) => sum + price, 0) / prices.length;
  return {
    low: prices[0],
    avg: average,
    high: prices[prices.length - 1],
    source: "Mercado Livre",
    references: results.slice(0, 5)
  };
}

async function getMarketPrices(query) {
  try {
    return await fetchMercadoLivrePrices(query);
  } catch (error) {
    return { ...estimatePrice(query), source: "Estimativa local", error: error.message, references: [] };
  }
}

async function getMarketplaceBreakdown(query) {
  const local = estimatePrice(query);
  const rows = [
    { name: "Mercado Livre", factor: 1, source: "Estimativa local" },
    { name: "OLX", factor: .86, source: "Estimativa local" },
    { name: "Amazon", factor: 1.18, source: "Estimativa local" },
    { name: "Shopee", factor: .78, source: "Estimativa local" },
    { name: "Google", factor: 1.04, source: "Estimativa local" }
  ].map(row => ({
    ...row,
    low: local.low * row.factor,
    avg: local.avg * row.factor,
    high: local.high * row.factor,
    references: []
  }));

  try {
    const ml = await fetchMercadoLivrePrices(query);
    rows[0] = { name: "Mercado Livre", ...ml, source: "Consulta real" };
  } catch (error) {
    rows[0].error = error.message;
  }
  return rows;
}

function estimatePrice(query) {
  const text = query.toLowerCase();
  let base = 220;
  if (text.includes("cobre")) base = 38;
  if (text.includes("alum")) base = 11;
  if (text.includes("motor")) base = 680;
  if (text.includes("placa") || text.includes("eletr")) base = 180;
  if (text.includes("compressor")) base = 950;
  if (text.includes("iphone") || text.includes("notebook")) base = 1400;
  const hash = [...text].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  base = base * (0.82 + (hash % 41) / 100);
  return { low: base * .72, avg: base, high: base * 1.38 };
}

function inferItemFromPhotoName(fileName = "produto usado") {
  const raw = fileName.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").trim() || "produto usado";
  const lower = raw.toLowerCase();
  const category = lower.includes("ferro") || lower.includes("cobre") || lower.includes("sucata")
    ? "Sucata"
    : lower.includes("novo")
      ? "Produto de revenda"
      : "PeÃ§a usada";
  let subcategory = "";
  if (lower.includes("motor")) subcategory = "Motor";
  if (lower.includes("placa") || lower.includes("eletr")) subcategory = "Eletronico";
  if (lower.includes("compressor")) subcategory = "Compressor";
  if (lower.includes("cobre")) subcategory = "cobre";
  if (lower.includes("alum")) subcategory = "aluminio";
  return { raw, category, subcategory, prices: estimatePrice(raw) };
}

async function identifyProductWithVision(dataUrl) {
  const apiKey = localStorage.getItem(OPENAI_KEY);
  if (apiKey) return identifyProductWithOpenAiKey(dataUrl, apiKey);

  const apiBase = localStorage.getItem("uniglobal-api-base") || "http://127.0.0.1:4174";
  const endpoint = location.protocol === "file:" || location.port === "4173"
    ? `${apiBase}/api/identify-product`
    : "/api/identify-product";

  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ image: dataUrl })
  }).catch(() => {
    throw new Error("Backend local nao encontrado. Abra iniciar-uniglobal.bat e acesse http://127.0.0.1:4174");
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || `Falha ao analisar imagem: ${response.status}`);
  }
  const payload = await response.json();
  return payload.product;
}

function extractOpenAiText(data) {
  if (data.output_text) return data.output_text;
  const chunks = [];
  for (const item of data.output || []) {
    for (const content of item.content || []) {
      if (content.text) chunks.push(content.text);
      if (content.type === "output_text" && content.text) chunks.push(content.text);
    }
  }
  return chunks.join("\n");
}

async function identifyProductWithOpenAiKey(dataUrl, apiKey) {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: "gpt-4.1-mini",
      input: [{
        role: "user",
        content: [
          {
            type: "input_text",
            text: "Identifique o produto da foto para cadastro de estoque. Responda apenas JSON valido com: name, category, subcategory, brand, model, condition, confidence, notes. Categorias permitidas: Sucata, PeÃ§a usada, Produto de revenda. Se marca/modelo nao estiverem visiveis, deixe vazio. Use portugues do Brasil."
          },
          { type: "input_image", image_url: dataUrl, detail: "low" }
        ]
      }],
      text: {
        format: {
          type: "json_schema",
          name: "product_identification",
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              name: { type: "string" },
              category: { type: "string", enum: ["Sucata", "PeÃ§a usada", "Produto de revenda"] },
              subcategory: { type: "string" },
              brand: { type: "string" },
              model: { type: "string" },
              condition: { type: "string" },
              confidence: { type: "number" },
              notes: { type: "string" }
            },
            required: ["name", "category", "subcategory", "brand", "model", "condition", "confidence", "notes"]
          },
          strict: true
        }
      }
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Falha na OpenAI: ${response.status} ${errorText.slice(0, 180)}`);
  }
  return JSON.parse(extractOpenAiText(await response.json()));
}

function applyAiSuggestionToForm(suggestion) {
  const form = document.querySelector("#itemForm");
  const query = `${suggestion.name || ""} ${suggestion.brand || ""} ${suggestion.model || ""}`.trim();
  const prices = estimatePrice(query || suggestion.name || "produto usado");
  if (suggestion.name) form.name.value = suggestion.name;
  if (suggestion.category) form.category.value = suggestion.category;
  form.subcategory.value = suggestion.subcategory || "";
  form.brand.value = suggestion.brand || "";
  form.model.value = suggestion.model || "";
  if (suggestion.condition) form.condition.value = [...form.condition.options].some(o => o.value === suggestion.condition) ? suggestion.condition : "desconhecido";
  form.marketValue.value = prices.avg.toFixed(2);
  form.suggestedValue.value = (prices.avg * .92).toFixed(2);
  form.saleValue.value = (prices.avg * .95).toFixed(2);
  document.querySelector("#priceQuery").value = query;
  renderPriceResult(document.querySelector("#priceResults"), query || suggestion.name);
}

async function renderPriceResult(target, query) {
  target.innerHTML = `<div class="result-card"><strong>Pesquisando preÃ§o...</strong><p>Montando comparativo por plataforma.</p></div>`;
  const rows = await getMarketplaceBreakdown(query);
  const prices = rows.find(row => row.name === "Mercado Livre" && row.source === "Consulta real") || rows[0];
  const refs = rows[0].references?.length
    ? `<div class="reference-list">${rows[0].references.map(item => `<a href="${item.link}" target="_blank" rel="noreferrer">${escapeHtml(item.title)} Â· ${money.format(item.price)}</a>`).join("")}</div>`
    : "";
  target.innerHTML = `
    <div class="result-card">
      <strong>Comparativo para "${escapeHtml(query)}"</strong>
      <div class="price-table">
        <div class="price-head"><span>Plataforma</span><span>Menor</span><span>Medio</span><span>Maior</span></div>
        ${rows.map(row => `<a href="${marketLinks(query).find(([name]) => name === row.name)?.[1] || "#"}" target="_blank" rel="noreferrer" class="price-row">
          <span>${escapeHtml(row.name)} <small>${escapeHtml(row.source)}</small></span>
          <strong>${money.format(row.low)}</strong>
          <strong>${money.format(row.avg)}</strong>
          <strong>${money.format(row.high)}</strong>
        </a>`).join("")}
      </div>
      ${rows[0].error ? `<p>Mercado Livre: ${escapeHtml(rows[0].error)}. Usando estimativa local nessa linha.</p>` : ""}
      ${refs}
      <div class="links">${marketLinks(query).map(([name, url]) => `<a href="${url}" target="_blank" rel="noreferrer">${name}</a>`).join("")}</div>
    </div>
  `;
  return prices;
}

function buildItem(form, photo = "") {
  const item = Object.fromEntries(new FormData(form).entries());
  item.id = crypto.randomUUID();
  item.code = code();
  item.photo = photo;
  item.ean = String(item.ean || "").trim();
  item.quantity = num(item.quantity) || 1;
  item.weight = num(item.weight);
  item.paidValue = num(item.paidValue);
  item.marketValue = num(item.marketValue);
  item.suggestedValue = num(item.suggestedValue);
  item.saleValue = num(item.saleValue);
  item.entryDate = item.entryDate || today;
  stampCreate(item);
  item.validationStatus = isAdmin() ? "approved" : "pending";
  return item;
}

function findDuplicateByEan(ean, ignoreId = "") {
  const clean = String(ean || "").trim();
  if (!clean) return null;
  return state.items.find(item => String(item.ean || "").trim() === clean && item.id !== ignoreId) || null;
}

function submitInventoryItem(item) {
  stampCreate(item);
  const duplicate = findDuplicateByEan(item.ean, item.id);
  if (duplicate && isAdmin()) {
    duplicate.quantity = num(duplicate.quantity) + num(item.quantity);
    stampUpdate(duplicate);
    duplicate.notes = [duplicate.notes, `Entrada adicional por EAN ${item.ean}: ${item.quantity} un.`].filter(Boolean).join("\n");
    state.sequence += 1;
    save();
    toast(`EAN ja existia. Quantidade somada em ${duplicate.code}`);
    return;
  }
  if (duplicate && !isAdmin()) {
    item.duplicateOf = duplicate.code;
    item.notes = [item.notes, `Possivel duplicidade por EAN: ${duplicate.code}`].filter(Boolean).join("\n");
  }

  if (isAdmin()) {
    state.items.unshift(item);
    toast(`${item.code} salvo no estoque`);
  } else {
    state.pendingItems.unshift(item);
    toast(`${item.code} enviado para validacao do administrador`);
  }
  state.sequence += 1;
  save();
}

function approvePendingItem(id) {
  const index = state.pendingItems.findIndex(item => item.id === id);
  if (index < 0) return;
  const [item] = state.pendingItems.splice(index, 1);
  const duplicate = findDuplicateByEan(item.ean, item.id);
  if (duplicate) {
    duplicate.quantity = num(duplicate.quantity) + num(item.quantity);
    stampUpdate(duplicate);
    duplicate.notes = [duplicate.notes, `Item validado e somado por EAN ${item.ean}: ${item.quantity} un.`].filter(Boolean).join("\n");
    save();
    renderAll();
    toast(`EAN ja existia. Quantidade somada em ${duplicate.code}`);
    return;
  }
  item.validationStatus = "approved";
  item.approvedAt = new Date().toISOString();
  item.approvedBy = currentUsername();
  stampUpdate(item);
  state.items.unshift(item);
  save();
  renderAll();
  toast(`${item.code} inserido no estoque`);
}

function rejectPendingItem(id, reason = "") {
  const index = state.pendingItems.findIndex(item => item.id === id);
  if (index < 0) return;
  const [item] = state.pendingItems.splice(index, 1);
  item.validationStatus = "rejected";
  item.rejectedAt = new Date().toISOString();
  item.rejectedBy = currentUsername();
  item.rejectionReason = reason;
  save();
  renderAll();
  toast(`${item.code} rejeitado`);
}

function deletePendingItem(id) {
  const item = state.pendingItems.find(product => product.id === id);
  if (!item) return;
  if (!confirm(`Excluir o cadastro pendente ${item.code} - ${item.name || "sem nome"}?`)) return;
  rejectPendingItem(id, "Excluido diretamente no alerta");
}

function deleteStockProduct(id) {
  if (!isAdmin()) return toast("Apenas administrador pode excluir item do estoque");
  const item = state.items.find(product => product.id === id);
  if (!item) return;
  if (item.status === "excluido") return toast("Item ja esta excluido");
  const reason = prompt(`Motivo da exclusao de ${item.code} - ${item.name || "produto"}:`);
  if (reason === null) return;
  const cleanReason = reason.trim();
  if (!cleanReason) return toast("Informe o motivo da exclusao");
  item.previousStatus = item.status;
  item.status = "excluido";
  item.deleteReason = cleanReason;
  item.deletedAt = new Date().toISOString();
  item.deletedBy = currentUsername();
  item.quantity = 0;
  item.weight = 0;
  stampUpdate(item);
  save();
  renderAll();
  document.querySelector("#productDialog")?.close();
  toast("Item excluido e enviado ao inventario de produtos");
}

function metrics() {
  const items = state.items;
  const inStock = items.filter(i => i.status !== "vendido" && i.status !== "descartado" && i.status !== "excluido");
  const totalValue = inStock.reduce((sum, i) => sum + (num(i.saleValue) || num(i.suggestedValue) || num(i.marketValue)) * (num(i.quantity) || 1), 0);
  const totalPaid = items.reduce((sum, i) => sum + num(i.paidValue), 0);
  const soldTotal = state.sales.reduce((sum, s) => sum + num(s.soldValue), 0);
  const estimatedProfit = inStock.reduce((sum, i) => sum + ((num(i.saleValue) || num(i.suggestedValue) || num(i.marketValue)) - num(i.paidValue)), 0);
  return { items, inStock, totalValue, totalPaid, soldTotal, estimatedProfit };
}

function thumb(item, className = "") {
  if (item.photo) return `<img class="${className}" src="${item.photo}" alt="" />`;
  return `<div class="thumb-placeholder ${className}">${escapeHtml((item.name || item.code).slice(0, 2).toUpperCase())}</div>`;
}

function itemRow(i) {
  return `<article class="item-row">
    <button class="thumb-button" data-open-product="${i.id}" data-product-source="stock">${thumb(i)}</button>
    <div><strong>${escapeHtml(i.code)} Â· ${escapeHtml(i.name || "Sem nome")}</strong><span>EAN ${escapeHtml(i.ean || "-")} Â· ${escapeHtml(i.location || "sem localizacao")} Â· ${daysSince(i.entryDate)} dias</span></div>
    <span class="pill">${escapeHtml(i.status)}</span>
  </article>`;
}

function itemCompact(i) {
  const level = daysSince(i.entryDate) >= 180 ? "+180 dias" : "+90 dias";
  return `<article class="calc-card"><strong>${escapeHtml(i.code)} Â· ${escapeHtml(i.name)}</strong><p>${level} em estoque Â· ${escapeHtml(i.location || "sem localizacao")} Â· ${money.format(num(i.saleValue) || num(i.suggestedValue))}</p></article>`;
}

function stockCard(item) {
  const value = num(item.saleValue) || num(item.suggestedValue) || num(item.marketValue);
  return `<article class="stock-card">
    <button class="stock-open" data-open-product="${item.id}" data-product-source="stock">${thumb(item, "stock-photo")}</button>
    <div class="stock-card-body">
      <span class="pill">${escapeHtml(item.status)}</span>
      <h3>${escapeHtml(item.code)} Â· ${escapeHtml(item.name || "Sem nome")}</h3>
      <p>EAN ${escapeHtml(item.ean || "-")} Â· ${escapeHtml(item.category)}</p>
      <dl>
        <div><dt>Marca</dt><dd>${escapeHtml(item.brand || "-")}</dd></div>
        <div><dt>Modelo</dt><dd>${escapeHtml(item.model || "-")}</dd></div>
        <div><dt>Qtd.</dt><dd>${num(item.quantity)}</dd></div>
        <div><dt>Peso</dt><dd>${num(item.weight)} kg</dd></div>
        <div><dt>Local</dt><dd>${escapeHtml(item.location || "sem localizacao")}</dd></div>
        <div><dt>Venda</dt><dd>${money.format(value)}</dd></div>
        <div><dt>NF compra</dt><dd>${escapeHtml(item.purchaseInvoice || "-")}</dd></div>
        <div><dt>Fornecedor</dt><dd>${escapeHtml(item.supplier || "-")}</dd></div>
      </dl>
    </div>
  </article>`;
}

function pendingCard(item) {
  const action = isAdmin()
    ? `<div class="actions inline-actions">
        <button class="primary-btn small-btn" data-open-product="${item.id}" data-product-source="pending">Validar</button>
        <button class="danger-btn small-btn" data-delete-pending="${item.id}">Excluir</button>
      </div>`
    : `<button class="secondary-btn" data-open-product="${item.id}" data-product-source="pending">Editar cadastro</button>`;
  return `<article class="pending-card">
    <button class="stock-open" data-open-product="${item.id}" data-product-source="pending">${thumb(item, "stock-photo")}</button>
    <div>
      <h3>${escapeHtml(item.code)} Â· ${escapeHtml(item.name || "Sem nome")}</h3>
      <p>EAN ${escapeHtml(item.ean || "-")} Â· criado por ${escapeHtml(item.createdBy || "colaborador")} Â· ${money.format(num(item.saleValue) || num(item.suggestedValue) || num(item.marketValue))}</p>
      <p>${escapeHtml(item.location || "sem localizacao")} Â· ${escapeHtml(item.notes || "sem observacoes")}</p>
      ${action}
    </div>
  </article>`;
}

function monthKey(date) {
  return (date || today).slice(0, 7);
}

function parseDate(value) {
  return value ? new Date(`${value}T00:00:00`) : null;
}

function saleProduct(sale) {
  const first = sale.items?.[0];
  return state.items.find(item => item.id === (first?.itemId || sale.itemId)) || {};
}

function saleLineItems(sale) {
  if (Array.isArray(sale.items) && sale.items.length) return sale.items;
  return [{
    itemId: sale.itemId,
    code: saleProduct(sale).code,
    name: saleProduct(sale).name,
    category: saleProduct(sale).category,
    soldWeight: num(sale.soldWeight),
    soldQuantity: num(sale.soldQuantity),
    unitSaleValue: (num(sale.soldWeight) || num(sale.soldQuantity)) ? num(sale.soldValue) / (num(sale.soldWeight) || num(sale.soldQuantity)) : num(sale.soldValue),
    soldValue: num(sale.soldValue),
    cost: saleCost(sale),
    profit: num(sale.profit)
  }];
}

function activeSales() {
  return state.sales.filter(sale => sale.status !== "cancelada" && sale.status !== "estornada");
}

function activeReceivables() {
  return state.receivables.filter(entry => !["Pago", "Cancelado", "Estornado"].includes(entry.status));
}

function receivableStatus(entry) {
  if (["Cancelado", "Estornado"].includes(entry.status)) return entry.status;
  if (num(entry.balanceOpen) <= 0) return "Pago";
  if (entry.dueDate && entry.dueDate < today) return "Vencido";
  if (num(entry.valuePaid) > 0 || num(entry.cashbackUsed) > 0) return "Parcial";
  return "Em aberto";
}

function salePaymentSummary(sale) {
  const value = num(sale.soldValue);
  const cashback = num(sale.cashbackUsed);
  const paidNow = num(sale.paidNow);
  const paidTotal = Math.min(value, cashback + paidNow);
  const balance = Math.max(0, value - paidTotal);
  const status = balance <= 0 ? "Paga" : paidTotal > 0 ? "Parcialmente paga" : "Pendente";
  return { value, cashback, paidNow, paidTotal, balance, status };
}

function upsertReceivableFromSale(sale) {
  const summary = salePaymentSummary(sale);
  let entry = state.receivables.find(item => item.saleId === sale.id);
  if (summary.balance <= 0) {
    if (entry) {
      entry.valuePaid = summary.paidTotal;
      entry.balanceOpen = 0;
      entry.status = "Pago";
      entry.paidAt ||= sale.soldAt || today;
      stampUpdate(entry);
    }
    return null;
  }
  const payload = {
    saleId: sale.id,
    customer: sale.customer || "",
    partner: sale.seller || sale.cashbackAccount || "",
    date: sale.soldAt || today,
    saleValue: summary.value,
    valuePaid: summary.paidNow,
    cashbackUsed: summary.cashback,
    balanceOpen: summary.balance,
    dueDate: sale.dueDate || "",
    paymentMethod: sale.balancePayment || sale.payment || "",
    notes: sale.financialNotes || "",
    status: ""
  };
  payload.status = receivableStatus(payload);
  if (entry) {
    Object.assign(entry, payload);
    stampUpdate(entry);
  } else {
    entry = stampCreate({ id: crypto.randomUUID(), ...payload });
    state.receivables.unshift(entry);
  }
  return entry;
}

function dashboardFilters() {
  return {
    start: document.querySelector("#dashStartDate")?.value || "",
    end: document.querySelector("#dashEndDate")?.value || "",
    category: document.querySelector("#dashCategory")?.value || "",
    client: (document.querySelector("#dashClient")?.value || "").toLowerCase(),
    product: (document.querySelector("#dashProduct")?.value || "").toLowerCase(),
    brand: (document.querySelector("#dashBrand")?.value || "").toLowerCase()
  };
}

function filterByDate(date, filters) {
  if (!date) return true;
  const current = parseDate(date);
  const start = parseDate(filters.start);
  const end = parseDate(filters.end);
  return (!start || current >= start) && (!end || current <= end);
}

function filteredDashboardData() {
  const filters = dashboardFilters();
  const items = state.items.filter(item => {
    const textProduct = `${item.name || ""} ${item.code || ""}`.toLowerCase();
    const brand = `${item.brand || ""}`.toLowerCase();
    return (!filters.category || item.category === filters.category)
      && (!filters.product || textProduct.includes(filters.product))
      && (!filters.brand || brand.includes(filters.brand));
  });
  const sales = activeSales().filter(sale => {
    const item = saleProduct(sale);
    const textProduct = `${item.name || ""} ${item.code || ""}`.toLowerCase();
    const brand = `${item.brand || ""}`.toLowerCase();
    return filterByDate(sale.soldAt, filters)
      && (!filters.category || item.category === filters.category)
      && (!filters.client || `${sale.customer || ""}`.toLowerCase().includes(filters.client))
      && (!filters.product || textProduct.includes(filters.product))
      && (!filters.brand || brand.includes(filters.brand));
  });
  const purchases = items.filter(item => filterByDate(item.entryDate, filters));
  return { filters, items, sales, purchases };
}

function sum(list, pick) {
  return list.reduce((total, item) => total + num(pick(item)), 0);
}

function saleCost(sale) {
  if (Array.isArray(sale.items) && sale.items.length) return sum(sale.items, line => line.cost);
  return Math.max(0, num(sale.soldValue) - num(sale.profit));
}

function margin(value, costOrProfit) {
  return value ? (costOrProfit / value) * 100 : 0;
}

function stockValue(items) {
  return items
    .filter(item => item.status !== "vendido" && item.status !== "descartado" && item.status !== "excluido")
    .reduce((total, item) => total + (num(item.saleValue) || num(item.suggestedValue) || num(item.marketValue)) * (num(item.quantity) || 1), 0);
}

function lastMonths(count = 12) {
  const date = new Date();
  const months = [];
  for (let index = count - 1; index >= 0; index--) {
    const d = new Date(date.getFullYear(), date.getMonth() - index, 1);
    months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  }
  return months;
}

function monthLabel(key) {
  const [year, month] = key.split("-").map(Number);
  return new Date(year, month - 1, 1).toLocaleDateString("pt-BR", { month: "short" }).replace(".", "");
}

function metricCards(cards) {
  return `<div class="dashboard-metrics">${cards.map(([label, value, detail, drill]) => `<article class="metric ${drill ? "clickable-row" : ""}" ${drill ? `data-dashboard-drill="${drill}"` : ""}><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong><small>${escapeHtml(detail || "")}</small></article>`).join("")}</div>`;
}

function barChart(title, rows) {
  const max = Math.max(1, ...rows.map(row => Math.max(num(row.value), num(row.value2))));
  return `<section class="panel chart-panel"><div class="panel-head"><h2>${escapeHtml(title)}</h2><span>${rows.length} pontos</span></div>
    <div class="bar-chart">${rows.map(row => `<div class="bar-row">
      <span>${escapeHtml(row.label)}</span>
      <div class="bar-track"><i style="width:${Math.min(100, (num(row.value) / max) * 100)}%"></i>${row.value2 !== undefined ? `<b style="width:${Math.min(100, (num(row.value2) / max) * 100)}%"></b>` : ""}</div>
      <strong>${money.format(num(row.value))}${row.value2 !== undefined ? " / " + money.format(num(row.value2)) : ""}</strong>
    </div>`).join("")}</div></section>`;
}

function lineChart(title, rows) {
  const max = Math.max(1, ...rows.map(row => num(row.value)));
  const points = rows.map((row, index) => `${(index / Math.max(1, rows.length - 1)) * 100},${100 - (num(row.value) / max) * 86}`).join(" ");
  return `<section class="panel chart-panel"><div class="panel-head"><h2>${escapeHtml(title)}</h2><span>${rows.length} meses</span></div>
    <svg class="line-chart" viewBox="0 0 100 105" preserveAspectRatio="none">
      <polyline points="${points}" fill="none" stroke="#c79a35" stroke-width="3" vector-effect="non-scaling-stroke"></polyline>
    </svg>
    <div class="chart-labels">${rows.map(row => `<span>${escapeHtml(row.label)}</span>`).join("")}</div>
  </section>`;
}

function pieChart(title, rows) {
  const total = rows.reduce((acc, row) => acc + Math.max(0, num(row.value)), 0) || 1;
  let cursor = 0;
  const colors = ["#c79a35", "#0a0a0a", "#747474", "#f4e6bd", "#a33a31"];
  const gradient = rows.map((row, index) => {
    const start = cursor;
    const size = (Math.max(0, num(row.value)) / total) * 100;
    cursor += size;
    return `${colors[index % colors.length]} ${start}% ${cursor}%`;
  }).join(", ");
  return `<section class="panel chart-panel"><div class="panel-head"><h2>${escapeHtml(title)}</h2><span>${rows.length} categorias</span></div>
    <div class="pie-wrap"><div class="pie-chart" style="background: conic-gradient(${gradient || "#eee 0 100%"});"></div>
    <div class="pie-legend">${rows.map((row, index) => `<span><i style="background:${colors[index % colors.length]}"></i>${escapeHtml(row.label)} Â· ${money.format(num(row.value))}</span>`).join("")}</div></div>
  </section>`;
}

function tablePanel(title, rows, columns) {
  return `<section class="panel table-panel"><div class="panel-head"><h2>${escapeHtml(title)}</h2><span>${rows.length} registros</span></div>
    <div class="data-table"><table><thead><tr>${columns.map(col => `<th>${escapeHtml(col.label)}</th>`).join("")}</tr></thead>
    <tbody>${rows.length ? rows.map(row => `<tr>${columns.map(col => `<td>${escapeHtml(col.format ? col.format(row[col.key], row) : row[col.key] ?? "")}</td>`).join("")}</tr>`).join("") : `<tr><td colspan="${columns.length}">Sem dados</td></tr>`}</tbody></table></div></section>`;
}

function dashboardRowsByMonth(data, months = lastMonths(12)) {
  return months.map(key => {
    const sales = data.sales.filter(sale => monthKey(sale.soldAt) === key);
    const purchases = data.purchases.filter(item => monthKey(item.entryDate) === key);
    const sold = sum(sales, sale => sale.soldValue);
    const bought = sum(purchases, item => item.paidValue);
    const profit = sum(sales, sale => sale.profit);
    return { key, label: monthLabel(key), sold, bought, profit, margin: margin(sold, profit), scrapWeight: sum(sales, sale => sale.soldWeight), quantity: sum(sales, sale => sale.soldQuantity), stock: stockValue(data.items) };
  });
}

function categorySummary(sales) {
  const map = {};
  sales.forEach(sale => {
    const item = saleProduct(sale);
    const key = item.category || "Sem categoria";
    map[key] ||= { category: key, sold: 0, profit: 0, quantity: 0 };
    map[key].sold += num(sale.soldValue);
    map[key].profit += num(sale.profit);
    map[key].quantity += num(sale.soldQuantity) + num(sale.soldWeight);
  });
  return Object.values(map).sort((a, b) => b.sold - a.sold);
}

function dashboardHtml(tab = activeDashboardTab) {
  const data = filteredDashboardData();
  const nowMonth = monthKey(today);
  const monthSales = data.sales.filter(sale => monthKey(sale.soldAt) === nowMonth);
  const monthPurchases = data.purchases.filter(item => monthKey(item.entryDate) === nowMonth);
  const inStock = data.items.filter(item => item.status !== "vendido" && item.status !== "descartado" && item.status !== "excluido");
  const soldMonth = sum(monthSales, sale => sale.soldValue);
  const boughtMonth = sum(monthPurchases, item => item.paidValue);
  const profitMonth = sum(monthSales, sale => sale.profit);
  const stockTotal = stockValue(data.items);
  const receivableOpen = activeReceivables();
  const receivableOverdue = receivableOpen.filter(entry => receivableStatus(entry) === "Vencido");
  const receivedMonth = sum(state.receivables.filter(entry => monthKey(entry.paidAt || entry.updatedAt || "") === nowMonth && receivableStatus(entry) === "Pago"), entry => entry.valuePaid);
  const biggestDebtor = [...receivableOpen].sort((a, b) => num(b.balanceOpen) - num(a.balanceOpen))[0];
  const stale90 = inStock.filter(item => daysSince(item.entryDate) > 90);
  const stale180 = inStock.filter(item => daysSince(item.entryDate) > 180);
  const lowStock = inStock.filter(item => item.category !== "Sucata" && num(item.quantity) <= 1);
  const months = dashboardRowsByMonth(data);
  const annualMonths = dashboardRowsByMonth(data, Array.from({ length: 12 }, (_, index) => `${new Date().getFullYear()}-${String(index + 1).padStart(2, "0")}`));
  const tabs = {
    principal: () => `${metricCards([
      ["Total vendido no mÃªs", money.format(soldMonth), "receita", "monthSales"],
      ["Total comprado no mÃªs", money.format(boughtMonth), "entradas"],
      ["Lucro bruto do mÃªs", money.format(profitMonth), "vendas - custo"],
      ["Contas a receber", money.format(sum(receivableOpen, entry => entry.balanceOpen)), "aberto"],
      ["Contas vencidas", money.format(sum(receivableOverdue, entry => entry.balanceOpen)), "atrasado"],
      ["Recebimentos mes", money.format(receivedMonth), "baixados"],
      ["Maior devedor", biggestDebtor ? biggestDebtor.customer : "-", biggestDebtor ? money.format(num(biggestDebtor.balanceOpen)) : ""],
      ["Margem mÃ©dia", `${margin(soldMonth, profitMonth).toFixed(1)}%`, "mÃªs atual"],
      ["Valor em estoque", money.format(stockTotal), "estimado"],
      ["Quantidade de itens", sum(inStock, item => item.quantity), "em estoque"],
      ["Sucata em estoque", `${sum(inStock.filter(i => i.category === "Sucata"), i => i.weight).toFixed(2)} kg`, "peso"],
      ["Anunciados", inStock.filter(i => i.status === "anunciado").length, "produtos"],
      ["Vendidos", data.sales.length, "vendas", "sales"],
      [">90 dias", stale90.length, "parados"],
      [">180 dias", stale180.length, "parados"],
      ["Estoque baixo", lowStock.length, "alertas"]
    ])}<div class="dashboard-grid">${lineChart("Receita mensal Ãºltimos 12 meses", months.map(row => ({ label: row.label, value: row.sold })))}${barChart("Compras x vendas", months.map(row => ({ label: row.label, value: row.bought, value2: row.sold })))}${lineChart("EvoluÃ§Ã£o do lucro mensal", months.map(row => ({ label: row.label, value: row.profit })))}${barChart("Categorias mais vendidas", categorySummary(data.sales).map(row => ({ label: row.category, value: row.sold })))}</div>`,
    anual: () => {
      const best = [...annualMonths].sort((a, b) => b.sold - a.sold)[0] || {};
      const worst = [...annualMonths].sort((a, b) => a.sold - b.sold)[0] || {};
      const first = annualMonths[0]?.sold || 0;
      const last = annualMonths.at(-1)?.sold || 0;
      const growth = first ? ((last - first) / first) * 100 : 0;
      return `${metricCards([["Melhor mÃªs", best.label || "-", money.format(best.sold)], ["Pior mÃªs", worst.label || "-", money.format(worst.sold)], ["Crescimento", `${growth.toFixed(1)}%`, "jan-dez"]])}
      <div class="dashboard-grid">${lineChart("Receita anual", annualMonths.map(row => ({ label: row.label, value: row.sold })))}${barChart("Compras x vendas", annualMonths.map(row => ({ label: row.label, value: row.bought, value2: row.sold })))}${pieChart("Categorias mais lucrativas", categorySummary(data.sales).map(row => ({ label: row.category, value: row.profit })))}</div>
      ${tablePanel("Resumo mÃªs a mÃªs", annualMonths, [
        { key: "label", label: "MÃªs" }, { key: "bought", label: "Compras", format: money.format }, { key: "sold", label: "Vendas", format: money.format }, { key: "profit", label: "Lucro", format: money.format }, { key: "margin", label: "Margem", format: value => `${num(value).toFixed(1)}%` }, { key: "scrapWeight", label: "Sucata kg" }, { key: "quantity", label: "Qtd vendida" }, { key: "stock", label: "Estoque", format: money.format }
      ])}`;
    },
    mensal: () => {
      const byClient = Object.values(monthSales.reduce((acc, sale) => { const key = sale.customer || "Sem cliente"; acc[key] ||= { name: key, total: 0 }; acc[key].total += num(sale.soldValue); return acc; }, {})).sort((a, b) => b.total - a.total);
      const byProduct = monthSales.map(sale => ({ product: saleProduct(sale).name || "Produto", total: num(sale.soldValue), profit: num(sale.profit) })).sort((a, b) => b.total - a.total);
      return `${metricCards([["Total vendido", money.format(soldMonth)], ["Total comprado", money.format(boughtMonth)], ["Lucro", money.format(profitMonth)], ["Ticket mÃ©dio", money.format(monthSales.length ? soldMonth / monthSales.length : 0)], ["Quantidade vendida", sum(monthSales, sale => num(sale.soldQuantity) || num(sale.soldWeight))]])}
      <div class="dashboard-grid">${barChart("Clientes que mais compraram", byClient.slice(0, 8).map(row => ({ label: row.name, value: row.total })))}${barChart("Produtos mais vendidos", byProduct.slice(0, 8).map(row => ({ label: row.product, value: row.total })))}${barChart("Produtos mais lucrativos", [...byProduct].sort((a,b)=>b.profit-a.profit).slice(0,8).map(row => ({ label: row.product, value: row.profit })))}</div>
      ${tablePanel("Ãšltimas vendas", monthSales.slice(0, 12).map(sale => ({ date: sale.soldAt, product: saleProduct(sale).name, customer: sale.customer, value: sale.soldValue, profit: sale.profit })), [
        { key: "date", label: "Data" }, { key: "product", label: "Produto" }, { key: "customer", label: "Cliente" }, { key: "value", label: "Valor", format: money.format }, { key: "profit", label: "Lucro", format: money.format }
      ])}`;
    },
    estoque: () => `${metricCards([["Valor total estimado", money.format(stockTotal)], ["Sucata", money.format(stockValue(inStock.filter(i=>i.category==="Sucata")))], ["PeÃ§as usadas", money.format(stockValue(inStock.filter(i=>i.category==="PeÃ§a usada")))], ["Revenda", money.format(stockValue(inStock.filter(i=>i.category==="Produto de revenda")))], [">90 dias", stale90.length], [">180 dias", stale180.length], ["Sem foto", inStock.filter(i=>!i.photo).length], ["Sem preÃ§o", inStock.filter(i=>!num(i.saleValue)&&!num(i.suggestedValue)&&!num(i.marketValue)).length], ["Sem anÃºncio", inStock.filter(i=>i.status!=="anunciado").length]])}
      ${tablePanel("Top 20 maiores valores parados em estoque", [...inStock].sort((a,b)=>(num(b.saleValue)||num(b.suggestedValue)||num(b.marketValue))-(num(a.saleValue)||num(a.suggestedValue)||num(a.marketValue))).slice(0,20).map(item => ({ code: item.code, product: item.name, category: item.category, days: daysSince(item.entryDate), value: num(item.saleValue)||num(item.suggestedValue)||num(item.marketValue) })), [
        { key: "code", label: "CÃ³digo" }, { key: "product", label: "Produto" }, { key: "category", label: "Categoria" }, { key: "days", label: "Dias" }, { key: "value", label: "Valor", format: money.format }
      ])}`,
    compraVenda: () => `${tablePanel("Compra x venda por produto", data.sales.map(sale => { const item = saleProduct(sale); return { product: item.name, buy: saleCost(sale), sell: sale.soldValue, profit: sale.profit, margin: margin(num(sale.soldValue), num(sale.profit)), boughtKg: item.category === "Sucata" ? num(sale.soldWeight) : "", soldKg: num(sale.soldWeight) || "", buyKg: num(sale.soldWeight) ? saleCost(sale) / num(sale.soldWeight) : "", sellKg: num(sale.soldWeight) ? num(sale.soldValue) / num(sale.soldWeight) : "" }; }), [
        { key: "product", label: "Produto" }, { key: "buy", label: "Compra", format: money.format }, { key: "sell", label: "Venda", format: money.format }, { key: "profit", label: "Lucro", format: money.format }, { key: "margin", label: "Margem", format: v => `${num(v).toFixed(1)}%` }, { key: "soldKg", label: "Kg vendido" }, { key: "buyKg", label: "Compra/kg", format: v => v === "" ? "" : money.format(v) }, { key: "sellKg", label: "Venda/kg", format: v => v === "" ? "" : money.format(v) }
      ])}${barChart("Lucro por categoria", categorySummary(data.sales).map(row => ({ label: row.category, value: row.profit })))}`,
    giro: () => {
      const buckets = { "0-30 dias": 0, "31-90 dias": 0, "91-180 dias": 0, "180+ dias": 0 };
      data.sales.forEach(sale => { const item = saleProduct(sale); const days = Math.max(0, Math.floor((new Date(sale.soldAt) - new Date(item.entryDate || sale.soldAt)) / 86400000)); buckets[days <= 30 ? "0-30 dias" : days <= 90 ? "31-90 dias" : days <= 180 ? "91-180 dias" : "180+ dias"] += 1; });
      const rate = state.items.length ? (data.sales.length / state.items.length) * 100 : 0;
      return `${metricCards([["Taxa de giro", `${rate.toFixed(1)}%`, "vendas / itens"], ["Vendas analisadas", data.sales.length]])}${barChart("Itens vendidos por faixa de giro", Object.entries(buckets).map(([label, value]) => ({ label, value })))}`;
    },
    rentabilidade: () => {
      const rows = data.sales.map(sale => ({ product: saleProduct(sale).name || "Produto", category: saleProduct(sale).category || "-", paid: saleCost(sale), sold: num(sale.soldValue), profit: num(sale.profit), margin: margin(num(sale.soldValue), num(sale.profit)) }));
      const columns = [{key:"product",label:"Produto"},{key:"category",label:"Categoria"},{key:"paid",label:"Valor pago",format:money.format},{key:"sold",label:"Valor vendido",format:money.format},{key:"profit",label:"Lucro",format:money.format},{key:"margin",label:"Margem",format:v=>`${num(v).toFixed(1)}%`}];
      return `${tablePanel("Produtos mais lucrativos", [...rows].sort((a,b)=>b.profit-a.profit).slice(0,10), columns)}
      ${tablePanel("Produtos menos lucrativos", [...rows].sort((a,b)=>a.profit-b.profit).slice(0,10), columns)}
      ${barChart("Categorias mais rentÃ¡veis", categorySummary(data.sales).map(row => ({ label: row.category, value: row.profit })))}`;
    }
  };

  return tabs[tab]?.() || tabs.principal();
}

function renderDashboard() {
  const content = document.querySelector("#dashboardContent");
  if (!content) return;
  content.innerHTML = dashboardHtml(activeDashboardTab);
  bindDashboardDrilldowns(content);
}

function bindDashboardDrilldowns(root) {
  root.querySelectorAll("[data-dashboard-drill]").forEach(card => {
    if (card.dataset.bound) return;
    card.dataset.bound = "true";
    card.addEventListener("click", () => openDashboardDrill(card.dataset.dashboardDrill));
  });
}

function openDashboardDrill(type) {
  const data = filteredDashboardData();
  const nowMonth = monthKey(today);
  const sales = type === "monthSales" ? data.sales.filter(sale => monthKey(sale.soldAt) === nowMonth) : data.sales;
  document.querySelector("#dashboardDrillTitle").textContent = type === "monthSales" ? "Vendas do mÃªs" : "Vendas realizadas";
  document.querySelector("#dashboardDrillBody").innerHTML = sales.length ? sales.map(sale => {
    const item = saleProduct(sale);
    return `<article class="calc-card clickable-row" data-open-sale="${sale.id}">
      <strong>${escapeHtml(item.code || "Venda")} Â· ${escapeHtml(item.name || "Produto")}</strong>
      <p>${escapeHtml(sale.soldAt || "-")} Â· ${escapeHtml(sale.customer || "sem cliente")} Â· ${money.format(num(sale.soldValue))}</p>
      <p>Status: ${escapeHtml(sale.status || "concluida")} Â· Lucro: ${money.format(num(sale.profit))}</p>
    </article>`;
  }).join("") : `<div class="empty">Nenhuma venda encontrada.</div>`;
  document.querySelector("#dashboardDrillBody").querySelectorAll("[data-open-sale]").forEach(row => {
    row.addEventListener("click", () => {
      document.querySelector("#dashboardDrillDialog").close();
      openSale(row.dataset.openSale);
    });
  });
  document.querySelector("#dashboardDrillDialog").showModal();
}

function renderStock() {
  const query = document.querySelector("#stockSearch")?.value.trim().toLowerCase() || "";
  const category = document.querySelector("#stockCategory")?.value || "";
  const filtered = state.items.filter(item => {
    const text = `${item.code} ${item.ean} ${item.name} ${item.brand} ${item.model} ${item.location} ${item.category}`.toLowerCase();
    return item.status !== "vendido" && item.status !== "descartado" && item.status !== "excluido" && (!query || text.includes(query)) && (!category || item.category === category);
  });
  document.querySelector("#stockCountLabel").textContent = `${filtered.length} itens visiveis`;
  document.querySelector("#stockGrid").innerHTML = filtered.length ? filtered.map(stockCard).join("") : `<div class="empty">Nenhum item encontrado no estoque.</div>`;
}

function renderPending() {
  const list = document.querySelector("#pendingList");
  if (!list) return;
  list.innerHTML = state.pendingItems.length ? state.pendingItems.map(pendingCard).join("") : `<div class="empty">Nenhum item aguardando validacao.</div>`;
  list.querySelectorAll("[data-delete-pending]").forEach(button => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      deletePendingItem(button.dataset.deletePending);
    });
  });
  bindProductOpeners(list);
}

function renderCollaboratorPending() {
  const panel = document.querySelector("#collaboratorPendingPanel");
  const list = document.querySelector("#collaboratorPendingList");
  if (!panel || !list) return;
  const user = getCurrentUser();
  panel.hidden = isAdmin() || !user;
  if (panel.hidden) return;
  const items = state.pendingItems.filter(item => item.createdBy === user.username);
  list.innerHTML = items.length
    ? items.map(pendingCard).join("")
    : `<div class="empty">Nenhum item pendente. Quando o administrador aprovar, o cadastro sai daqui e entra no estoque.</div>`;
  bindProductOpeners(list);
}

function renderSaleOptions() {
  const select = document.querySelector("#saleItem");
  const sellable = state.items.filter(i => i.status !== "vendido" && i.status !== "descartado" && i.status !== "excluido");
  select.innerHTML = sellable.map(i => `<option value="${i.id}">${escapeHtml(i.code)} Ã‚Â· ${escapeHtml(i.name)}</option>`).join("");
  renderCustomerOptions();
  renderSaleItemPreview();
  updateSaleMeasureUI();
}

function renderSaleItemPreview() {
  const target = document.querySelector("#saleItemPreview");
  const form = document.querySelector("#saleForm");
  if (!target || !form) return;
  const item = state.items.find(product => product.id === form.itemId.value);
  if (!item) {
    target.innerHTML = `<div class="empty">Selecione um item para visualizar a foto e os dados.</div>`;
    return;
  }
  const available = item.category === "Sucata" ? `${num(item.weight)} kg` : `${num(item.quantity)} un.`;
  const value = num(item.saleValue) || num(item.suggestedValue) || num(item.marketValue);
  target.innerHTML = `<button type="button" class="sale-item-card" data-open-product="${item.id}" data-product-source="stock">
    ${thumb(item, "sale-item-photo")}
    <span>
      <strong>${escapeHtml(item.code)} Ã‚Â· ${escapeHtml(item.name || "Sem nome")}</strong>
      <small>EAN ${escapeHtml(item.ean || "-")} Ã‚Â· ${escapeHtml(item.category || "-")} Ã‚Â· Disponivel: ${escapeHtml(available)}</small>
      <small>${escapeHtml(item.location || "sem localizacao")} Ã‚Â· Valor base: ${money.format(value)}</small>
    </span>
  </button>`;
  bindProductOpeners(target);
}

function currentSaleLineFromForm() {
  const form = document.querySelector("#saleForm");
  const item = state.items.find(product => product.id === form.itemId.value);
  if (!item) return null;
  const isScrap = item.category === "Sucata";
  const soldMeasure = num(form.soldMeasure.value);
  const soldWeight = isScrap ? soldMeasure : 0;
  const soldQuantity = isScrap ? 0 : (soldMeasure || 1);
  if (isScrap && soldWeight <= 0) return { error: "Informe quantos kg de sucata foram vendidos" };
  if (!isScrap && soldQuantity <= 0) return { error: "Informe a quantidade vendida" };
  const alreadyInCart = sum(saleCart.filter(line => line.itemId === item.id), line => line.soldWeight || line.soldQuantity);
  const requested = isScrap ? soldWeight : soldQuantity;
  const available = isScrap ? num(item.weight) : num(item.quantity);
  if (requested + alreadyInCart > available) return { error: isScrap ? "Kg vendido maior que o peso em estoque" : "Quantidade vendida maior que o estoque" };
  const cost = isScrap && num(item.weight)
    ? num(item.paidValue) * (soldWeight / num(item.weight))
    : num(item.paidValue) * (soldQuantity / Math.max(num(item.quantity), 1));
  const soldValue = num(form.soldValue.value);
  if (soldValue <= 0) return { error: "Informe o valor vendido deste item" };
  return {
    id: crypto.randomUUID(),
    itemId: item.id,
    code: item.code,
    name: item.name,
    category: item.category,
    soldWeight,
    soldQuantity,
    unitSaleValue: num(form.unitSaleValue.value) || (requested ? soldValue / requested : soldValue),
    soldValue,
    cost,
    profit: soldValue - cost
  };
}

function renderSaleCart() {
  const target = document.querySelector("#saleCart");
  const form = document.querySelector("#saleForm");
  if (!target || !form) return;
  if (!saleCart.length) {
    target.innerHTML = `<div class="empty">Nenhum item adicionado nesta venda.</div>`;
    return;
  }
  const total = sum(saleCart, line => line.soldValue);
  const cost = sum(saleCart, line => line.cost);
  const profit = sum(saleCart, line => line.profit);
  target.innerHTML = `<div class="data-table"><table>
    <thead><tr><th>Produto</th><th>Medida</th><th>Unitario</th><th>Total</th><th>Lucro</th><th></th></tr></thead>
    <tbody>${saleCart.map(line => `<tr>
      <td>${escapeHtml(line.code)} - ${escapeHtml(line.name || "Produto")}</td>
      <td>${line.soldWeight ? `${num(line.soldWeight)} kg` : `${num(line.soldQuantity)} un.`}</td>
      <td>${money.format(num(line.unitSaleValue))}</td>
      <td>${money.format(num(line.soldValue))}</td>
      <td>${money.format(num(line.profit))}</td>
      <td><button type="button" class="danger-btn small-btn" data-remove-sale-line="${line.id}">Remover</button></td>
    </tr>`).join("")}</tbody>
  </table></div>
  <div class="sale-summary">
    <div><span>Total da venda</span><strong>${money.format(total)}</strong></div>
    <div><span>Custo total</span><strong>${money.format(cost)}</strong></div>
    <div><span>Lucro total</span><strong>${money.format(profit)}</strong></div>
  </div>`;
  target.querySelectorAll("[data-remove-sale-line]").forEach(button => {
    button.addEventListener("click", () => {
      saleCart = saleCart.filter(line => line.id !== button.dataset.removeSaleLine);
      renderSaleCart();
      updateCashbackBalanceInfo();
    });
  });
}

function addCurrentItemToSaleCart() {
  const line = currentSaleLineFromForm();
  if (!line) return toast("Nenhum item selecionado");
  if (line.error) return toast(line.error);
  saleCart.push(line);
  renderSaleCart();
  updateCashbackBalanceInfo();
  const form = document.querySelector("#saleForm");
  form.soldMeasure.value = "";
  form.soldValue.value = "";
  form.unitSaleValue.dataset.saleUnitMode = "auto";
  syncSaleUnitValue(true);
  updateSalePreview();
  toast(`${line.code} adicionado a venda`);
}

function renderCustomerOptions() {
  const list = document.querySelector("#customerOptions");
  if (!list) return;
  const customers = state.contacts.filter(isCustomerContact);
  list.innerHTML = customers.map(contact => `<option value="${escapeHtml(contact.name)}">${escapeHtml(contact.document || contact.phone || contact.email || "")}</option>`).join("");
  renderSupplierOptions();
  renderSellerOptions();
}

function isCustomerContact(contact) {
  return ["Cliente", "Cliente comum", "Parceiro recorrente", "Cliente faturado", "Interno", "Cliente e fornecedor", "Vendedor"].includes(contact?.type);
}

function findRegisteredCustomer(name) {
  const clean = `${name || ""}`.trim().toLowerCase();
  if (!clean) return null;
  return state.contacts.find(contact =>
    isCustomerContact(contact)
    && contact.name.trim().toLowerCase() === clean
  ) || null;
}

function renderSupplierOptions() {
  const list = document.querySelector("#supplierOptions");
  if (!list) return;
  const suppliers = state.contacts.filter(contact => contact.type === "Fornecedor" || contact.type === "Cliente e fornecedor");
  list.innerHTML = suppliers.map(contact => `<option value="${escapeHtml(contact.name)}">${escapeHtml(contact.document || contact.phone || contact.email || "")}</option>`).join("");
}

function renderSellerOptions() {
  const list = document.querySelector("#sellerOptions");
  if (!list) return;
  const sellers = state.contacts.filter(contact => contact.type === "Vendedor");
  list.innerHTML = sellers.map(contact => `<option value="${escapeHtml(contact.name)}">${escapeHtml(contact.cashbackPercent ? contact.cashbackPercent + "% cashback" : contact.phone || contact.email || "")}</option>`).join("");
}

function renderInvoiceOptions() {
  const select = document.querySelector("#invoiceSale");
  if (!select) return;
  select.innerHTML = state.sales.length
    ? state.sales.map(sale => {
      const item = state.items.find(i => i.id === sale.itemId);
      return `<option value="${sale.id}">${escapeHtml(item?.code || "Venda")} Â· ${escapeHtml(item?.name || sale.customer || "Cliente")} Â· ${money.format(num(sale.soldValue))}</option>`;
    }).join("")
    : `<option value="">Nenhuma venda registrada</option>`;
}

function renderInvoices() {
  const list = document.querySelector("#invoiceList");
  if (!list) return;
  document.querySelector("#invoiceCount").textContent = `${state.invoices.length} notas`;
  list.innerHTML = state.invoices.length ? state.invoices.map(invoice => `<article class="calc-card">
    <strong>${escapeHtml(invoice.number)} Â· ${money.format(num(invoice.value))}</strong>
    <p>${escapeHtml(invoice.status)} Â· ${escapeHtml(invoice.document || "sem documento")} Â· ${escapeHtml(invoice.issuedAt)}</p>
  </article>`).join("") : `<div class="empty">Nenhuma nota fiscal cadastrada.</div>`;
}

function renderSalesList() {
  const list = document.querySelector("#salesList");
  if (!list) return;
  document.querySelector("#salesCount").textContent = `${state.sales.length} vendas`;
  list.innerHTML = state.sales.length ? state.sales.map(sale => {
    const item = state.items.find(product => product.id === sale.itemId) || {};
    const invoice = state.invoices.find(note => note.saleId === sale.id);
    const lines = saleLineItems(sale);
    const measure = lines.length > 1 ? `${lines.length} itens` : (num(sale.soldWeight) ? `${num(sale.soldWeight)} kg` : `${num(sale.soldQuantity) || 1} un.`);
    const closed = sale.status === "cancelada" || sale.status === "estornada";
    return `<article class="calc-card clickable-row" data-open-sale="${sale.id}">
      <strong>${escapeHtml(item.code || "Venda")} Â· ${escapeHtml(item.name || "Produto")}</strong>
      <p>${escapeHtml(sale.soldAt)} Â· ${escapeHtml(sale.customer || "sem cliente")} Â· ${measure} Â· ${money.format(num(sale.soldValue))}</p>
      <p>Status: ${escapeHtml(sale.status || "concluida")} Â· Vendedor: ${escapeHtml(sale.seller || "-")} Â· Cashback: ${money.format(num(sale.cashbackValue))}</p>
      ${sale.cashbackBlockedReason ? `<p>${escapeHtml(sale.cashbackBlockedReason)}</p>` : ""}
      <p>Lucro: ${money.format(num(sale.profit))} Â· Nota: ${invoice ? escapeHtml(invoice.number) + " / " + escapeHtml(invoice.status) : "sem nota"}</p>
      ${sale.reversalReason ? `<p>Motivo: ${escapeHtml(sale.reversalReason)}</p>` : ""}
      ${closed ? "" : `<div class="actions inline-actions">
        <button class="secondary-btn small-btn" data-cancel-sale="${sale.id}">Cancelar venda</button>
        <button class="danger-btn small-btn" data-refund-sale="${sale.id}">Estornar cliente</button>
        <button class="secondary-btn small-btn" data-print-sale="${sale.id}">PDF</button>
      </div>`}
    </article>`;
  }).join("") : `<div class="empty">Nenhuma venda registrada.</div>`;
  list.querySelectorAll("[data-cancel-sale]").forEach(button => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      reverseSale(button.dataset.cancelSale, "cancelada");
    });
  });
  list.querySelectorAll("[data-refund-sale]").forEach(button => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      reverseSale(button.dataset.refundSale, "estornada");
    });
  });
  list.querySelectorAll("[data-print-sale]").forEach(button => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      printSale(button.dataset.printSale);
    });
  });
  list.querySelectorAll("[data-open-sale]").forEach(row => {
    row.addEventListener("click", () => openSale(row.dataset.openSale));
  });
}

function productInventoryRows() {
  const productRows = state.items.map(item => ({
    tipo: item.status === "excluido" ? "Produto excluido" : "Produto",
    data: item.deletedAt || item.soldAt || item.entryDate || item.createdAt || "",
    codigo: item.code,
    ean: item.ean,
    produto: item.name,
    categoria: item.category,
    cliente: item.customer || "",
    vendedor: "",
    medida: item.category === "Sucata" ? `${num(item.weight)} kg` : `${num(item.quantity)} un.`,
    valor: num(item.finalSoldValue) || num(item.saleValue) || num(item.suggestedValue) || num(item.marketValue),
    lucro: "",
    status: item.status || "em estoque",
    motivo: item.deleteReason || "",
    rastreabilidade: item.status === "excluido"
      ? `Excluido por ${item.deletedBy || "-"} em ${item.deletedAt ? new Date(item.deletedAt).toLocaleString("pt-BR") : "-"}`
      : auditLine(item),
    id: item.id,
    openType: "product"
  }));
  const saleRows = state.sales.flatMap(sale => {
    return saleLineItems(sale).map(line => ({
      tipo: "Venda",
      data: sale.soldAt || sale.createdAt || "",
      codigo: line.code || saleProduct(sale).code || "",
      ean: state.items.find(product => product.id === line.itemId)?.ean || "",
      produto: line.name || "Produto",
      categoria: line.category || "",
      cliente: sale.customer || "",
      vendedor: sale.seller || "",
      medida: num(line.soldWeight) ? `${num(line.soldWeight)} kg` : `${num(line.soldQuantity) || 1} un.`,
      valor: num(line.soldValue),
      lucro: num(line.profit),
      status: sale.status || "concluida",
      motivo: sale.reversalReason || "",
      rastreabilidade: auditLine(sale),
      id: sale.id,
      openType: "sale"
    }));
  });
  return [...productRows, ...saleRows].sort((a, b) => new Date(b.data || 0) - new Date(a.data || 0));
}

function renderSalesInventory() {
  const target = document.querySelector("#salesInventory");
  if (!target) return;
  const count = document.querySelector("#salesInventoryCount");
  const rows = productInventoryRows();
  if (count) count.textContent = `${rows.length} movimentacoes registradas`;
  if (!rows.length) {
    target.innerHTML = `<div class="empty">Nenhum produto movimentado.</div>`;
    return;
  }
  target.innerHTML = `<table>
    <thead><tr>
      <th>Tipo</th><th>Data</th><th>Codigo</th><th>Produto</th><th>Cliente</th><th>Vendedor</th><th>Medida</th><th>Valor</th><th>Lucro</th><th>Status</th><th>Motivo</th><th>Rastreabilidade</th>
    </tr></thead>
    <tbody>${rows.map(row => {
      const openAttrs = row.openType === "sale" ? `data-open-sale="${row.id}"` : `data-open-product="${row.id}" data-product-source="stock"`;
      return `<tr class="clickable-row" ${openAttrs}>
        <td>${escapeHtml(row.tipo)}</td>
        <td>${escapeHtml(row.data || "-")}</td>
        <td>${escapeHtml(row.codigo || "-")}</td>
        <td>${escapeHtml(row.produto || "-")}</td>
        <td>${escapeHtml(row.cliente || "-")}</td>
        <td>${escapeHtml(row.vendedor || "-")}</td>
        <td>${escapeHtml(row.medida || "-")}</td>
        <td>${money.format(num(row.valor))}</td>
        <td>${row.lucro === "" ? "-" : money.format(num(row.lucro))}</td>
        <td>${escapeHtml(row.status || "-")}</td>
        <td>${escapeHtml(row.motivo || "-")}</td>
        <td>${escapeHtml(row.rastreabilidade || "-")}</td>
      </tr>`;
    }).join("")}</tbody>
  </table>`;
  target.querySelectorAll("[data-open-sale]").forEach(row => {
    row.addEventListener("click", () => openSale(row.dataset.openSale));
  });
  bindProductOpeners(target);
}

function filteredReceivables() {
  const client = document.querySelector("#receivableClientFilter")?.value.trim().toLowerCase() || "";
  const status = document.querySelector("#receivableStatusFilter")?.value || "";
  const start = document.querySelector("#receivableStartFilter")?.value || "";
  const end = document.querySelector("#receivableEndFilter")?.value || "";
  return state.receivables.map(entry => ({ ...entry, status: receivableStatus(entry) })).filter(entry => {
    const text = `${entry.customer} ${entry.partner}`.toLowerCase();
    return (!client || text.includes(client))
      && (!status || entry.status === status)
      && (!start || (entry.dueDate || entry.date || "") >= start)
      && (!end || (entry.dueDate || entry.date || "") <= end);
  });
}

function renderReceivables() {
  const list = document.querySelector("#receivablesList");
  const dashboard = document.querySelector("#receivablesDashboard");
  if (!list || !dashboard) return;
  state.receivables.forEach(entry => entry.status = receivableStatus(entry));
  const rows = filteredReceivables().sort((a, b) => new Date(a.dueDate || a.date || 0) - new Date(b.dueDate || b.date || 0));
  const openRows = state.receivables.map(entry => ({ ...entry, status: receivableStatus(entry) })).filter(entry => !["Pago", "Cancelado", "Estornado"].includes(entry.status));
  const overdue = openRows.filter(entry => entry.status === "Vencido");
  const todayRows = openRows.filter(entry => entry.dueDate === today);
  const monthRows = openRows.filter(entry => monthKey(entry.dueDate || entry.date) === monthKey(today));
  document.querySelector("#receivablesCount").textContent = `${rows.length} contas`;
  dashboard.innerHTML = metricCards([
    ["Total aberto", money.format(sum(openRows, row => row.balanceOpen)), "saldo pendente"],
    ["Total vencido", money.format(sum(overdue, row => row.balanceOpen)), "atrasado"],
    ["Receber hoje", money.format(sum(todayRows, row => row.balanceOpen)), today],
    ["Receber mes", money.format(sum(monthRows, row => row.balanceOpen)), monthLabel(monthKey(today))]
  ]);
  list.innerHTML = rows.length ? rows.map(entry => `<article class="calc-card">
    <strong>${escapeHtml(entry.customer || "Cliente")} - ${money.format(num(entry.balanceOpen))}</strong>
    <p>Venda: ${money.format(num(entry.saleValue))} - Pago: ${money.format(num(entry.valuePaid))} - Cashback: ${money.format(num(entry.cashbackUsed))}</p>
    <p>Status: ${escapeHtml(entry.status)} - Vencimento: ${escapeHtml(entry.dueDate || "-")} - Forma: ${escapeHtml(entry.paymentMethod || "-")}</p>
    <p>Parceiro: ${escapeHtml(entry.partner || "-")} - Obs: ${escapeHtml(entry.notes || "-")}</p>
    <div class="actions inline-actions">
      <button type="button" class="secondary-btn small-btn" data-receivable-partial="${entry.id}">Pagamento parcial</button>
      <button type="button" class="primary-btn small-btn" data-receivable-full="${entry.id}">Baixar total</button>
      <button type="button" class="secondary-btn small-btn" data-receivable-due="${entry.id}">Editar vencimento</button>
      <button type="button" class="secondary-btn small-btn" data-open-sale="${entry.saleId}">Abrir venda</button>
    </div>
  </article>`).join("") : `<div class="empty">Nenhuma conta a receber encontrada.</div>`;
  list.querySelectorAll("[data-receivable-partial]").forEach(button => button.addEventListener("click", () => payReceivable(button.dataset.receivablePartial, false)));
  list.querySelectorAll("[data-receivable-full]").forEach(button => button.addEventListener("click", () => payReceivable(button.dataset.receivableFull, true)));
  list.querySelectorAll("[data-receivable-due]").forEach(button => button.addEventListener("click", () => editReceivableDue(button.dataset.receivableDue)));
  list.querySelectorAll("[data-open-sale]").forEach(button => button.addEventListener("click", () => openSale(button.dataset.openSale)));
}

function payReceivable(id, full = false) {
  const entry = state.receivables.find(item => item.id === id);
  if (!entry) return;
  const currentBalance = num(entry.balanceOpen);
  const value = full ? currentBalance : num(prompt("Valor recebido:", currentBalance.toFixed(2)));
  if (!value || value <= 0) return;
  if (value > currentBalance) return toast("Valor recebido maior que o saldo aberto");
  entry.valuePaid = num(entry.valuePaid) + value;
  entry.balanceOpen = Math.max(0, currentBalance - value);
  entry.status = receivableStatus(entry);
  if (entry.status === "Pago") entry.paidAt = new Date().toISOString();
  entry.notes = [entry.notes, `Recebimento de ${money.format(value)} por ${currentUsername()} em ${new Date().toLocaleString("pt-BR")}`].filter(Boolean).join("\n");
  stampUpdate(entry);
  const sale = state.sales.find(item => item.id === entry.saleId);
  if (sale) {
    sale.paidNow = num(sale.paidNow) + value;
    sale.paymentStatus = salePaymentSummary(sale).status;
    stampUpdate(sale);
  }
  save();
  toast(entry.status === "Pago" ? "Conta baixada" : "Pagamento parcial registrado");
}

function editReceivableDue(id) {
  const entry = state.receivables.find(item => item.id === id);
  if (!entry) return;
  const dueDate = prompt("Novo vencimento (AAAA-MM-DD):", entry.dueDate || today);
  if (dueDate === null) return;
  entry.dueDate = dueDate.trim();
  entry.status = receivableStatus(entry);
  stampUpdate(entry);
  save();
  toast("Vencimento atualizado");
}

function saleDetails(id) {
  const sale = state.sales.find(item => item.id === id);
  if (!sale) return null;
  const item = state.items.find(product => product.id === sale.itemId) || {};
  const invoice = state.invoices.find(note => note.saleId === sale.id);
  const lines = saleLineItems(sale);
  const measure = lines.length > 1 ? `${lines.length} itens` : (num(sale.soldWeight) ? `${num(sale.soldWeight)} kg` : `${num(sale.soldQuantity) || 1} un.`);
  return { sale, item, invoice, measure };
}

function openSale(id) {
  const details = saleDetails(id);
  if (!details) return;
  activeSaleId = id;
  const { sale, item, invoice, measure } = details;
  const lines = saleLineItems(sale);
  const itemsText = lines.map(line => `${line.code || ""} - ${line.name || "Produto"} (${line.soldWeight ? `${num(line.soldWeight)} kg` : `${num(line.soldQuantity) || 1} un.`}) - ${money.format(num(line.soldValue))}`).join("\n");
  document.querySelector("#saleDialogTitle").textContent = `${item.code || "Venda"} - ${lines.length > 1 ? `Venda com ${lines.length} itens` : item.name || "Produto"}`;
  document.querySelector("#saleDialogBody").innerHTML = [
    ["Status", sale.status || "concluida"],
    ["Produto", lines.length > 1 ? `${lines.length} itens na venda` : item.name],
    ["Itens", itemsText],
    ["Codigo", item.code],
    ["EAN", item.ean],
    ["Cliente", sale.customer],
    ["Vendedor", sale.seller],
    ["Cashback %", sale.cashbackPercent ? `${num(sale.cashbackPercent).toFixed(2)}%` : "-"],
    ["Cashback", money.format(num(sale.cashbackValue))],
    ["Cashback usado", money.format(num(sale.cashbackUsed))],
    ["Pago agora", money.format(num(sale.paidNow))],
    ["Saldo restante", money.format(num(sale.balanceOpen))],
    ["Status financeiro", sale.paymentStatus || salePaymentSummary(sale).status],
    ["Vencimento saldo", sale.dueDate],
    ["Pagamento saldo", sale.balancePayment],
    ["Regra cashback", sale.cashbackBlockedReason || "normal"],
    ["Data da venda", sale.soldAt],
    ["Medida vendida", measure],
    ["Valor vendido", money.format(num(sale.soldValue))],
    ["Forma de pagamento", sale.payment],
    ["Canal", sale.channel],
    ["Lucro", money.format(num(sale.profit))],
    ["Criado por", sale.createdBy],
    ["Criado em", sale.createdAt ? new Date(sale.createdAt).toLocaleString("pt-BR") : ""],
    ["Editado por", sale.updatedBy],
    ["Editado em", sale.updatedAt ? new Date(sale.updatedAt).toLocaleString("pt-BR") : ""],
    ["Nota fiscal", invoice ? `${invoice.number} Â· ${invoice.status}` : "sem nota"],
    ["Cancelamento/estorno", sale.reversalReason],
    ["Feito por", sale.reversedBy],
    ["Data do evento", sale.reversedAt ? new Date(sale.reversedAt).toLocaleString("pt-BR") : ""]
  ].map(([label, value]) => `<div class="detail-item"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value || "-")}</strong></div>`).join("");
  const closed = sale.status === "cancelada" || sale.status === "estornada";
  document.querySelector("#cancelSaleFromDialog").style.display = closed ? "none" : "";
  document.querySelector("#refundSaleFromDialog").style.display = closed ? "none" : "";
  document.querySelector("#saleDialog").showModal();
}

function printSale(id) {
  const details = saleDetails(id);
  if (!details) return;
  const { sale, item, invoice, measure } = details;
  const lines = saleLineItems(sale);
  const linesHtml = lines.map(line => `<tr><td>${escapeHtml(line.code || "")}</td><td>${escapeHtml(line.name || "Produto")}</td><td>${line.soldWeight ? `${num(line.soldWeight)} kg` : `${num(line.soldQuantity) || 1} un.`}</td><td>${money.format(num(line.soldValue))}</td></tr>`).join("");
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Venda ${item.code || ""}</title>
    <style>body{font-family:Arial,sans-serif;padding:28px;color:#111}h1{margin:0 0 6px}table{width:100%;border-collapse:collapse;margin-top:20px}td,th{border:1px solid #ddd;padding:10px;text-align:left}.brand{color:#b88723;font-weight:700}.status{font-weight:700}</style>
    </head><body>
    <div class="brand">UNIGLOBAL STOCK AI</div>
    <h1>Comprovante de venda</h1>
    <p class="status">Status: ${escapeHtml(sale.status || "concluida")}</p>
    <table><tbody>
      <tr><th>Produto</th><td>${escapeHtml(item.code || "")} Â· ${escapeHtml(item.name || "")}</td></tr>
      <tr><th>EAN</th><td>${escapeHtml(item.ean || "-")}</td></tr>
      <tr><th>Cliente</th><td>${escapeHtml(sale.customer || "-")}</td></tr>
      <tr><th>Data</th><td>${escapeHtml(sale.soldAt || "-")}</td></tr>
      <tr><th>Medida vendida</th><td>${escapeHtml(measure)}</td></tr>
      <tr><th>Itens</th><td><table><thead><tr><th>Codigo</th><th>Produto</th><th>Medida</th><th>Valor</th></tr></thead><tbody>${linesHtml}</tbody></table></td></tr>
      <tr><th>Valor vendido</th><td>${money.format(num(sale.soldValue))}</td></tr>
      <tr><th>Pago</th><td>${money.format(num(sale.paidNow))}</td></tr>
      <tr><th>Cashback usado</th><td>${money.format(num(sale.cashbackUsed))}</td></tr>
      <tr><th>Saldo restante</th><td>${money.format(num(sale.balanceOpen))}</td></tr>
      <tr><th>Status financeiro</th><td>${escapeHtml(sale.paymentStatus || salePaymentSummary(sale).status)}</td></tr>
      <tr><th>Lucro</th><td>${money.format(num(sale.profit))}</td></tr>
      <tr><th>Pagamento</th><td>${escapeHtml(sale.payment || "-")}</td></tr>
      <tr><th>Canal</th><td>${escapeHtml(sale.channel || "-")}</td></tr>
      <tr><th>Nota fiscal</th><td>${invoice ? `${escapeHtml(invoice.number)} Â· ${escapeHtml(invoice.status)}` : "sem nota"}</td></tr>
      <tr><th>Historico</th><td>${escapeHtml(sale.reversalReason || "Venda concluida sem cancelamento/estorno")}</td></tr>
    </tbody></table>
    <script>window.print();</script>
    </body></html>`;
  const win = window.open("", "_blank");
  win.document.write(html);
  win.document.close();
}

function reverseSale(id, status) {
  const sale = state.sales.find(item => item.id === id);
  if (!sale || sale.status === "cancelada" || sale.status === "estornada") return;
  const reason = prompt(status === "cancelada" ? "Motivo do cancelamento:" : "Motivo do estorno:");
  if (reason === null) return;
  saleLineItems(sale).forEach(line => {
    const product = state.items.find(item => item.id === line.itemId);
    if (!product) return;
    if (num(line.soldWeight)) {
      product.weight = num(product.weight) + num(line.soldWeight);
      product.quantity = 1;
      product.paidValue = num(product.paidValue) + num(line.cost);
    } else {
      product.quantity = num(product.quantity) + (num(line.soldQuantity) || 1);
    }
    if (product.status === "vendido") product.status = "em estoque";
    stampUpdate(product);
  });
  sale.status = status;
  sale.reversalReason = reason.trim() || "sem motivo informado";
  sale.reversedAt = new Date().toISOString();
  sale.reversedBy = currentUsername();
  sale.reversalValue = sale.soldValue;
  stampUpdate(sale);
  const invoice = state.invoices.find(note => note.saleId === sale.id);
  if (invoice) {
    invoice.status = "cancelada";
    invoice.notes = [invoice.notes, `${status} em ${new Date().toLocaleString("pt-BR")}: ${sale.reversalReason}`].filter(Boolean).join("\n");
    stampUpdate(invoice);
  }
  const receivable = state.receivables.find(entry => entry.saleId === sale.id);
  if (receivable) {
    receivable.balanceOpen = 0;
    receivable.status = status === "cancelada" ? "Cancelado" : "Estornado";
    receivable.notes = [receivable.notes, `${status} da venda: ${sale.reversalReason}`].filter(Boolean).join("\n");
    stampUpdate(receivable);
  }
  save();
  toast(status === "cancelada" ? "Venda cancelada e estoque restaurado" : "Estorno registrado e estoque restaurado");
}

function editSale(id) {
  const sale = state.sales.find(item => item.id === id);
  if (!sale) return;
  if (sale.status === "cancelada" || sale.status === "estornada") return toast("Venda cancelada/estornada nao pode ser editada");
  if (saleLineItems(sale).length > 1) return toast("Venda com varios itens: cancele/estorne e registre novamente para alterar itens");
  const form = document.querySelector("#saleEditForm");
  const item = state.items.find(product => product.id === sale.itemId) || {};
  editingSaleId = id;
  form.itemId.value = sale.itemId;
  document.querySelector("#saleEditItemName").value = `${item.code || "Venda"} - ${item.name || "Produto"}`;
  form.soldAt.value = sale.soldAt || today;
  form.soldMeasure.value = num(sale.soldWeight) || num(sale.soldQuantity) || 1;
  form.unitSaleValue.value = (num(sale.soldWeight) || num(sale.soldQuantity)) ? (num(sale.soldValue) / (num(sale.soldWeight) || num(sale.soldQuantity))).toFixed(2) : "";
  form.unitSaleValue.dataset.saleUnitMode = "manual";
  form.soldValue.value = num(sale.soldValue).toFixed(2);
  form.customer.value = sale.customer || "";
  form.seller.value = sale.seller || "";
  form.cashbackPercent.value = num(sale.cashbackPercent);
  form.cashbackUsed.value = num(sale.cashbackUsed);
  if (form.paidNow) form.paidNow.value = num(sale.paidNow);
  if (form.dueDate) form.dueDate.value = sale.dueDate || "";
  if (form.balancePayment) form.balancePayment.value = sale.balancePayment || "";
  if (form.cardFee) form.cardFee.value = num(sale.cardFee);
  form.payment.value = sale.payment || "";
  form.channel.value = sale.channel || "OLX";
  const invoice = state.invoices.find(note => note.saleId === sale.id);
  form.invoiceEnabled.value = invoice ? "sim" : "nao";
  form.invoiceNumber.value = invoice?.number || "";
  form.invoiceDocument.value = invoice?.document || "";
  form.invoiceStatus.value = invoice?.status || "pendente";
  form.invoiceNotes.value = invoice?.notes || "";
  form.querySelector("button[type='submit']").textContent = "Salvar alteraÃ§Ãµes da venda";
  document.querySelector("#saleDialog")?.close();
  updateSaleEditPreview();
  document.querySelector("#saleEditDialog").showModal();
}

function renderReports() {
  const target = document.querySelector("#reportsCharts");
  if (!target) return;
  target.innerHTML = dashboardHtml(activeReportTab);
}

function renderUsers() {
  const list = document.querySelector("#usersList");
  if (!list) return;
  list.innerHTML = state.users.map(user => `<article class="item-row user-row">
    <div class="thumb-placeholder">${user.role === "admin" ? "AD" : "CO"}</div>
    <div><strong>${escapeHtml(user.username)}</strong><span>${user.role === "admin" ? "Administrador" : "Colaborador"} Ã‚Â· ${escapeHtml(auditLine(user))}</span></div>
    <div class="row-actions">
      <span class="pill">${escapeHtml(user.role)}</span>
      <button class="secondary-btn small-btn" data-edit-user="${user.id}">Editar</button>
      <button class="danger-btn small-btn" data-delete-user="${user.id}">Apagar</button>
    </div>
  </article>`).join("");
  list.querySelectorAll("[data-edit-user]").forEach(button => {
    button.addEventListener("click", () => editUser(button.dataset.editUser));
  });
  list.querySelectorAll("[data-delete-user]").forEach(button => {
    button.addEventListener("click", () => deleteUser(button.dataset.deleteUser));
  });
  const keyInput = document.querySelector("#openaiKey");
  if (keyInput && !keyInput.value) keyInput.value = localStorage.getItem(OPENAI_KEY) || "";
}

function editUser(id) {
  const user = state.users.find(item => item.id === id);
  if (!user) return;
  editingUserId = id;
  const form = document.querySelector("#userForm");
  form.username.value = user.username;
  form.password.value = user.password;
  form.role.value = user.role;
  form.querySelector("button[type='submit']").textContent = "Salvar alteraÃ§Ãµes";
  switchView("configuracao");
}

function deleteUser(id) {
  const user = state.users.find(item => item.id === id);
  if (!user) return;
  const adminCount = state.users.filter(item => item.role === "admin").length;
  if (user.role === "admin" && adminCount <= 1) return toast("Nao e possivel apagar o ultimo administrador");
  if (getCurrentUser()?.id === id) return toast("Voce nao pode apagar o usuario logado");
  if (!confirm(`Apagar o usuario ${user.username}?`)) return;
  state.users = state.users.filter(item => item.id !== id);
  if (editingUserId === id) {
    editingUserId = "";
    document.querySelector("#userForm").reset();
    document.querySelector("#userForm button[type='submit']").textContent = "Adicionar usuario";
  }
  save();
  toast("Usuario apagado");
}

function renderContacts() {
  const list = document.querySelector("#contactsList");
  if (!list) return;
  document.querySelector("#contactsCount").textContent = `${state.contacts.length} cadastrados`;
  list.innerHTML = state.contacts.length ? state.contacts.map(contact => `<article class="item-row contact-row clickable-row" data-open-contact="${contact.id}">
    <div class="thumb-placeholder">${contact.type?.startsWith("Fornecedor") ? "FO" : "CL"}</div>
    <div>
      <strong>${escapeHtml(contact.name)}</strong>
      <span>${escapeHtml(contact.type)} Â· ${escapeHtml(contact.document || "sem documento")} Â· ${escapeHtml(contact.phone || "sem telefone")}</span>
      <span>${escapeHtml(contact.email || "")} ${contact.contactPerson ? "Â· " + escapeHtml(contact.contactPerson) : ""}</span>
    </div>
    <div class="row-actions">
      <span class="pill">${escapeHtml(contact.status)}</span>
      <button class="secondary-btn small-btn" data-edit-contact="${contact.id}">Editar</button>
      <button class="danger-btn small-btn" data-delete-contact="${contact.id}">Apagar</button>
    </div>
  </article>`).join("") : `<div class="empty">Nenhum cliente ou fornecedor cadastrado.</div>`;
  list.querySelectorAll("[data-edit-contact]").forEach(button => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      editContact(button.dataset.editContact);
    });
  });
  list.querySelectorAll("[data-delete-contact]").forEach(button => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      deleteContact(button.dataset.deleteContact);
    });
  });
  list.querySelectorAll("[data-open-contact]").forEach(row => {
    row.addEventListener("click", () => openContact(row.dataset.openContact));
  });
}

function renderSellersDashboard() {
  const target = document.querySelector("#sellersDashboard");
  if (!target) return;
  target.classList.add("sellers-dashboard");
  const sellers = state.contacts.filter(contact => contact.type === "Vendedor");
  const rows = sellers.map(seller => {
    const sales = activeSales().filter(sale => sale.seller === seller.name);
    const usedSales = activeSales().filter(sale => sale.cashbackAccount === seller.name);
    const sold = sum(sales, sale => sale.soldValue);
    const cashback = sum(sales, sale => sale.cashbackValue);
    const used = sum(usedSales, sale => sale.cashbackUsed);
    return {
      name: seller.name,
      phone: seller.phone,
      count: sales.length,
      sold,
      cashback,
      used,
      balance: cashback - used,
      avgCashback: sold ? (cashback / sold) * 100 : 0
    };
  }).sort((a, b) => b.sold - a.sold);
  target.innerHTML = `${metricCards([
    ["Vendedores", sellers.length, "cadastrados"],
    ["Vendas com vendedor", sum(rows, row => row.count), "quantidade"],
    ["Valor vendido", money.format(sum(rows, row => row.sold)), "por vendedores"],
    ["Cashback gerado", money.format(sum(rows, row => row.cashback)), "comissÃµes"],
    ["Cashback usado", money.format(sum(rows, row => row.used)), "encontro de contas"],
    ["Saldo cashback", money.format(sum(rows, row => row.balance)), "a pagar/usar"]
  ])}${barChart("Valor vendido por vendedor", rows.map(row => ({ label: row.name, value: row.sold })))}${tablePanel("Resumo de vendedores", rows, [
    { key: "name", label: "Vendedor" },
    { key: "phone", label: "Contato" },
    { key: "count", label: "Vendas" },
    { key: "sold", label: "Valor vendido", format: money.format },
    { key: "avgCashback", label: "% mÃ©dio", format: value => `${num(value).toFixed(2)}%` },
    { key: "cashback", label: "Gerado", format: money.format },
    { key: "used", label: "Usado", format: money.format },
    { key: "balance", label: "Saldo", format: money.format }
  ])}`;
  target.querySelectorAll(".data-table tbody tr").forEach((row, index) => {
    const seller = rows[index];
    if (!seller) return;
    row.classList.add("clickable-row");
    row.dataset.sellerRow = seller.name;
    const cells = row.querySelectorAll("td");
    if (cells[0]) cells[0].innerHTML = `<button class="table-action" data-open-seller="${escapeHtml(seller.name)}">${escapeHtml(seller.name)}</button>`;
    if (cells[2]) cells[2].innerHTML = `<button class="table-action badge-action" data-open-seller="${escapeHtml(seller.name)}">${seller.count} venda${seller.count === 1 ? "" : "s"}</button>`;
    row.addEventListener("click", () => openSellerDetails(seller.name));
  });
  target.querySelectorAll("[data-open-seller]").forEach(button => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      openSellerDetails(button.dataset.openSeller);
    });
  });
}

function openSellerDetails(name) {
  const seller = state.contacts.find(contact => contact.type === "Vendedor" && contact.name === name);
  const generatedSales = activeSales().filter(sale => sale.seller === name);
  const usedSales = activeSales().filter(sale => sale.cashbackAccount === name && num(sale.cashbackUsed) > 0);
  const generated = sum(generatedSales, sale => sale.cashbackValue);
  const used = sum(usedSales, sale => sale.cashbackUsed);
  document.querySelector("#sellerDialogTitle").textContent = name;
  document.querySelector("#sellerDialogBody").innerHTML = `${metricCards([
    ["Vendas feitas", generatedSales.length, "quantidade"],
    ["Valor vendido", money.format(sum(generatedSales, sale => sale.soldValue)), "total"],
    ["Cashback gerado", money.format(generated), `${num(seller?.cashbackPercent).toFixed(2)}% padrÃ£o`],
    ["Cashback usado", money.format(used), "abatido em vendas"],
    ["Saldo", money.format(generated - used), "disponÃ­vel"]
  ])}
  <div class="calc-card"><strong>Como abater cashback</strong><p>Na tela SaÃ­da / Venda, selecione esse vendedor como cliente e informe o valor em <b>Cashback usado (R$)</b>. O sistema baixa esse valor do saldo dele automaticamente.</p></div>
  ${tablePanel("Vendas que geraram cashback", generatedSales.map(sale => ({ id: sale.id, data: sale.soldAt, produto: saleProduct(sale).name, valor: sale.soldValue, cashback: sale.cashbackValue })), [
    { key: "data", label: "Data" }, { key: "produto", label: "Produto" }, { key: "valor", label: "Venda", format: money.format }, { key: "cashback", label: "Cashback", format: money.format }
  ])}
  ${tablePanel("Uso/abatimento de cashback", usedSales.map(sale => ({ id: sale.id, data: sale.soldAt, produto: saleProduct(sale).name, valor: sale.soldValue, usado: sale.cashbackUsed })), [
    { key: "data", label: "Data" }, { key: "produto", label: "Produto" }, { key: "valor", label: "Venda", format: money.format }, { key: "usado", label: "Cashback usado", format: money.format }
  ])}`;
  document.querySelectorAll("#sellerDialogBody .data-table").forEach((table, tableIndex) => {
    const sales = tableIndex === 0 ? generatedSales : usedSales;
    table.querySelectorAll("tbody tr").forEach((row, index) => {
      const sale = sales[index];
      if (!sale) return;
      row.classList.add("clickable-row");
      row.addEventListener("click", () => openSale(sale.id));
    });
  });
  document.querySelector("#sellerDialog").showModal();
}

function getSellerCashbackBalance(name) {
  if (!name) return 0;
  const generated = sum(activeSales().filter(sale => sale.seller === name), sale => sale.cashbackValue);
  const used = sum(activeSales().filter(sale => sale.cashbackAccount === name), sale => sale.cashbackUsed);
  return generated - used;
}

function saleCashbackAccount() {
  const form = document.querySelector("#saleForm");
  const customerAsSeller = state.contacts.find(contact => contact.type === "Vendedor" && contact.name.trim().toLowerCase() === form.customer.value.trim().toLowerCase());
  return customerAsSeller?.name || form.seller.value || "";
}

function updateCashbackBalanceInfo() {
  const info = document.querySelector("#cashbackBalanceInfo");
  if (!info) return;
  const account = saleCashbackAccount();
  const balance = getSellerCashbackBalance(account);
  const form = document.querySelector("#saleForm");
  const used = num(form.cashbackUsed.value);
  const paidNow = num(form.paidNow?.value);
  const cartTotal = saleCart.length ? sum(saleCart, line => line.soldValue) : num(form.soldValue.value);
  const remainingPayment = Math.max(0, cartTotal - used - paidNow);
  if (!account) {
    info.innerHTML = "Selecione um vendedor/cliente para ver saldo de cashback.";
    return;
  }
  info.innerHTML = `<strong>Cashback disponivel de ${escapeHtml(account)}: ${money.format(balance)}</strong><span>Usando: ${money.format(used)} - Pago agora: ${money.format(paidNow)} - Saldo da venda: ${money.format(remainingPayment)}</span>`;
}

function openContact(id) {
  const contact = state.contacts.find(item => item.id === id);
  if (!contact) return;
  activeContactId = id;
  document.querySelector("#contactDialogTitle").textContent = contact.name;
  document.querySelector("#contactDialogBody").innerHTML = [
    ["Tipo", contact.type],
    ["CPF / CNPJ", contact.document],
    ["Telefone", contact.phone],
    ["E-mail", contact.email],
    ["Contato responsÃ¡vel", contact.contactPerson],
    ["EndereÃ§o", contact.address],
    ["Status", contact.status],
    ["ObservaÃ§Ãµes", contact.notes],
    ["Criado por", contact.createdBy],
    ["Criado em", contact.createdAt ? new Date(contact.createdAt).toLocaleString("pt-BR") : ""],
    ["Editado por", contact.updatedBy],
    ["Editado em", contact.updatedAt ? new Date(contact.updatedAt).toLocaleString("pt-BR") : ""]
  ].map(([label, value]) => `<div class="detail-item"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value || "-")}</strong></div>`).join("");
  document.querySelector("#contactDialog").showModal();
}

function editContact(id) {
  const contact = state.contacts.find(item => item.id === id);
  if (!contact) return;
  editingContactId = id;
  const form = document.querySelector("#contactForm");
  form.dataset.editingId = id;
  ["type", "name", "document", "phone", "email", "contactPerson", "cashbackPercent", "address", "status", "notes"].forEach(field => {
    if (form.elements[field]) form.elements[field].value = contact[field] || "";
  });
  form.querySelector("button[type='submit']").textContent = "Salvar alteraÃ§Ãµes";
  document.querySelector("#contactDialog")?.close();
  switchView("contatos");
}

function deleteContact(id) {
  const contact = state.contacts.find(item => item.id === id);
  if (!contact) return;
  if (!confirm(`Apagar o cadastro de ${contact.name}?`)) return;
  state.contacts = state.contacts.filter(item => item.id !== id);
  if (editingContactId === id) {
    editingContactId = "";
    const form = document.querySelector("#contactForm");
    form.dataset.editingId = "";
    form.reset();
    form.querySelector("button[type='submit']").textContent = "Salvar cadastro";
  }
  document.querySelector("#contactDialog")?.close();
  save();
  toast("Cadastro apagado");
}

function updateAlertBadge() {
  const button = document.querySelector('.nav button[data-view="alerta"]');
  if (!button) return;
  const count = state.pendingItems.length;
  button.innerHTML = `Alerta ${count ? `<span class="nav-badge">${count}</span>` : ""}`;
}

function render() {
  document.querySelector("#nextCode").textContent = `Proximo codigo: ${code()}`;
  renderDashboard();
  renderStock();
  renderPending();
  renderCollaboratorPending();
  renderSaleOptions();
  renderSaleCart();
  renderInvoiceOptions();
  renderInvoices();
  renderSalesList();
  renderSalesInventory();
  renderReceivables();
  renderReports();
  renderUsers();
  renderContacts();
  renderSellersDashboard();
  updateAlertBadge();
  bindProductOpeners(document);
}

function renderAll() {
  render();
}

function applyPermissions() {
  const allowed = allowedViews();
  document.querySelectorAll(".nav button").forEach(button => {
    button.hidden = !allowed.includes(button.dataset.view);
  });
}

function switchView(id) {
  if (!allowedViews().includes(id)) id = isAdmin() ? "dashboard" : "cadastro";
  const button = document.querySelector(`.nav button[data-view="${id}"]`);
  if (!button) return;
  document.querySelectorAll(".nav button").forEach(b => b.classList.remove("active"));
  document.querySelectorAll(".view").forEach(v => v.classList.remove("active"));
  button.classList.add("active");
  document.querySelector(`#${id}`).classList.add("active");
  document.querySelector("#pageTitle").textContent = views[id];
  document.querySelector(".sidebar").classList.remove("open");
}

function bindProductOpeners(root) {
  root.querySelectorAll("[data-open-product]").forEach(button => {
    if (button.dataset.bound) return;
    button.dataset.bound = "true";
    button.addEventListener("click", () => openProduct(button.dataset.openProduct, button.dataset.productSource));
  });
}

function openProduct(id, source = "stock") {
  const collection = source === "pending" ? state.pendingItems : state.items;
  const item = collection.find(product => product.id === id);
  if (!item) return;
  if (source === "stock" && !isAdmin()) return toast("Item ja aprovado. Apenas administrador pode alterar estoque.");
  if (source === "pending" && !isAdmin() && item.createdBy !== getCurrentUser()?.username) return toast("Voce so pode editar os itens cadastrados por voce");
  activeProduct = { id, source };
  const dialog = document.querySelector("#productDialog");
  const form = document.querySelector("#productEditForm");
  document.querySelector("#productDialogTitle").textContent = `${item.code} Â· ${item.name || "Produto"}`;
  document.querySelector("#dialogPhoto").innerHTML = thumb(item, "stock-photo");
  const invoiceLink = item.purchaseInvoiceFile
    ? `<a href="${item.purchaseInvoiceFile}" target="_blank" rel="noreferrer">${escapeHtml(item.purchaseInvoiceFileName || "Abrir NF anexada")}</a>`
    : "Sem anexo";
  document.querySelector("#dialogPhoto").insertAdjacentHTML("beforeend", `<div class="trace-box"><strong>Rastreabilidade</strong><span>Fornecedor: ${escapeHtml(item.supplier || "-")}</span><span>NF: ${escapeHtml(item.purchaseInvoice || "-")}</span><span>Compra: ${escapeHtml(item.purchaseDate || "-")}</span><span>${escapeHtml(auditLine(item))}</span><span>${invoiceLink}</span></div>`);
  ["ean", "name", "category", "subcategory", "brand", "model", "quantity", "weight", "paidValue", "marketValue", "suggestedValue", "saleValue", "supplier", "purchaseInvoice", "purchaseDate", "purchaseInvoiceKey", "location", "status", "notes"].forEach(name => {
    if (form.elements[name]) form.elements[name].value = item[name] ?? "";
  });
  const canValidatePending = source === "pending" && isAdmin();
  document.querySelector("#approveFromDialog").style.display = canValidatePending ? "" : "none";
  document.querySelector("#rejectFromDialog").style.display = canValidatePending ? "" : "none";
  document.querySelector("#deleteProductFromDialog").style.display = source === "stock" && isAdmin() && item.status !== "excluido" ? "" : "none";
  document.querySelector("#dialogPriceResults").innerHTML = "";
  dialog.showModal();
}

function saveActiveProduct() {
  if (!activeProduct) return null;
  const collection = activeProduct.source === "pending" ? state.pendingItems : state.items;
  const item = collection.find(product => product.id === activeProduct.id);
  if (!item) return null;
  const data = Object.fromEntries(new FormData(document.querySelector("#productEditForm")).entries());
  Object.assign(item, data, {
    ean: String(data.ean || "").trim(),
    quantity: num(data.quantity),
    weight: num(data.weight),
    paidValue: num(data.paidValue),
    marketValue: num(data.marketValue),
    suggestedValue: num(data.suggestedValue),
    saleValue: num(data.saleValue),
    supplier: data.supplier,
    purchaseInvoice: data.purchaseInvoice,
    purchaseDate: data.purchaseDate,
    purchaseInvoiceKey: data.purchaseInvoiceKey
  });
  stampUpdate(item);
  return item;
}

function exportTable(filename, rows) {
  if (!rows.length) return toast("Nao ha dados para exportar");
  const headers = Object.keys(rows[0]);
  const html = `<html><head><meta charset="utf-8"></head><body><table border="1"><thead><tr>${headers.map(h => `<th>${escapeHtml(h)}</th>`).join("")}</tr></thead><tbody>${rows.map(row => `<tr>${headers.map(h => `<td>${escapeHtml(row[h] ?? "")}</td>`).join("")}</tr>`).join("")}</tbody></table></body></html>`;
  const blob = new Blob([html], { type: "application/vnd.ms-excel;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function downloadCsv(filename, rows) {
  if (!rows.length) return toast("Nao ha dados para exportar");
  const headers = Object.keys(rows[0]);
  const csv = [
    headers.join(";"),
    ...rows.map(row => headers.map(header => `"${String(row[header] ?? "").replace(/"/g, '""')}"`).join(";"))
  ].join("\n");
  const blob = new Blob([`\ufeff${csv}`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function dashboardExportRows() {
  const data = filteredDashboardData();
  if (activeDashboardTab === "anual") return dashboardRowsByMonth(data, Array.from({ length: 12 }, (_, index) => `${new Date().getFullYear()}-${String(index + 1).padStart(2, "0")}`));
  if (activeDashboardTab === "mensal") return data.sales.map(sale => ({ data: sale.soldAt, produto: saleProduct(sale).name, cliente: sale.customer, valor: sale.soldValue, lucro: sale.profit }));
  if (activeDashboardTab === "estoque") return data.items.map(item => ({ codigo: item.code, produto: item.name, categoria: item.category, quantidade: item.quantity, peso: item.weight, valor: num(item.saleValue) || num(item.suggestedValue) || num(item.marketValue), dias: daysSince(item.entryDate) }));
  if (activeDashboardTab === "compraVenda") return data.sales.map(sale => ({ produto: saleProduct(sale).name, compra: saleCost(sale), venda: sale.soldValue, lucro: sale.profit, margem: margin(num(sale.soldValue), num(sale.profit)).toFixed(1) }));
  if (activeDashboardTab === "giro") return data.sales.map(sale => ({ produto: saleProduct(sale).name, entrada: saleProduct(sale).entryDate, venda: sale.soldAt, dias: Math.max(0, Math.floor((new Date(sale.soldAt) - new Date(saleProduct(sale).entryDate || sale.soldAt)) / 86400000)) }));
  if (activeDashboardTab === "rentabilidade") return data.sales.map(sale => ({ produto: saleProduct(sale).name, categoria: saleProduct(sale).category, valor_pago: saleCost(sale), valor_vendido: sale.soldValue, lucro: sale.profit, margem: margin(num(sale.soldValue), num(sale.profit)).toFixed(1) }));
  return dashboardRowsByMonth(data);
}

document.querySelectorAll(".nav button").forEach(btn => {
  btn.addEventListener("click", () => switchView(btn.dataset.view));
});

document.addEventListener("click", (event) => {
  const editContactButton = event.target.closest("[data-edit-contact]");
  if (editContactButton) {
    event.preventDefault();
    event.stopPropagation();
    editContact(editContactButton.dataset.editContact);
    return;
  }
  const editUserButton = event.target.closest("[data-edit-user]");
  if (editUserButton) {
    event.preventDefault();
    event.stopPropagation();
    editUser(editUserButton.dataset.editUser);
    return;
  }
});

document.querySelectorAll("[data-dashboard-tab]").forEach(button => {
  button.addEventListener("click", () => {
    activeDashboardTab = button.dataset.dashboardTab;
    document.querySelectorAll("[data-dashboard-tab]").forEach(tab => tab.classList.remove("active"));
    button.classList.add("active");
    renderDashboard();
  });
});

document.querySelectorAll("[data-report-tab]").forEach(button => {
  button.addEventListener("click", () => {
    activeReportTab = button.dataset.reportTab;
    document.querySelectorAll("[data-report-tab]").forEach(tab => tab.classList.remove("active"));
    button.classList.add("active");
    renderReports();
  });
});

["#dashStartDate", "#dashEndDate", "#dashCategory", "#dashClient", "#dashProduct", "#dashBrand"].forEach(selector => {
  document.querySelector(selector)?.addEventListener("input", () => {
    renderDashboard();
    renderReports();
  });
});

["#receivableClientFilter", "#receivableStatusFilter", "#receivableStartFilter", "#receivableEndFilter"].forEach(selector => {
  document.querySelector(selector)?.addEventListener("input", renderReceivables);
});

document.querySelector("#exportDashboardExcel")?.addEventListener("click", () => {
  exportTable(`dashboard-${activeDashboardTab}.xls`, dashboardExportRows());
});

document.querySelector("#exportDashboardCsv")?.addEventListener("click", () => {
  downloadCsv(`dashboard-${activeDashboardTab}.csv`, dashboardExportRows());
});

document.querySelector("#exportDashboardPdf")?.addEventListener("click", () => {
  window.print();
});

document.querySelector("#loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  document.querySelector("#loginError").textContent = "Conectando ao banco online...";
  await loadCloudState();
  const data = Object.fromEntries(new FormData(e.target).entries());
  const user = state.users.find(item => item.username === data.username && item.password === data.password);
  if (!user) {
    document.querySelector("#loginError").textContent = "Usuario ou senha incorretos.";
    return;
  }
  document.querySelector("#loginError").textContent = "";
  sessionStorage.setItem(AUTH_KEY, user.username);
  unlockApp();
  toast(cloudLastError ? "Acesso liberado em modo local" : `Acesso liberado online: ${user.role === "admin" ? "administrador" : "colaborador"}`);
});

document.querySelector("#logoutBtn").addEventListener("click", () => {
  sessionStorage.removeItem(AUTH_KEY);
  lockApp();
});

document.querySelector("#refreshAppBtn")?.addEventListener("click", async () => {
  const button = document.querySelector("#refreshAppBtn");
  const oldText = button.textContent;
  button.disabled = true;
  button.textContent = "Atualizando...";
  try {
    await loadCloudState();
    renderAll();
    updateCloudStatus(`<strong>Status: atualizado</strong><span>${cloudStateSummary()} - ${new Date().toLocaleString("pt-BR")}</span>`);
    toast("Sistema atualizado");
  } finally {
    button.disabled = false;
    button.textContent = oldText;
  }
});

document.querySelector("#menuToggle").addEventListener("click", () => document.querySelector(".sidebar").classList.toggle("open"));
document.querySelector("input[name='entryDate']").value = today;
document.querySelector("input[name='soldAt']").value = today;
if (document.querySelector("input[name='issuedAt']")) document.querySelector("input[name='issuedAt']").value = today;

document.querySelector("input[name='photo']").addEventListener("change", async (e) => {
  const src = await fileToDataURL(e.target.files[0]);
  const img = document.querySelector("#photoPreview");
  img.src = src;
  img.style.display = src ? "block" : "none";
  if (!e.target.files[0]) return;
  document.querySelector("#aiResult").innerHTML = `<div class="result-card"><strong>Analisando foto...</strong><p>Aguarde enquanto a IA identifica o produto.</p></div>`;
  try {
    const suggestion = await identifyProductWithVision(src);
    applyAiSuggestionToForm(suggestion);
    document.querySelector("#aiResult").innerHTML = `<div class="result-card"><strong>Produto identificado pela foto</strong><p>${escapeHtml(suggestion.name)} Â· ${escapeHtml(suggestion.category)} Â· confianÃ§a ${Math.round(num(suggestion.confidence) * 100)}%</p><p>${escapeHtml(suggestion.notes)}</p></div>`;
  } catch (error) {
    const fallback = inferItemFromPhotoName(e.target.files[0].name);
    applyAiSuggestionToForm({
      name: fallback.raw,
      category: fallback.category,
      subcategory: fallback.subcategory,
      brand: "",
      model: "",
      condition: "desconhecido",
      confidence: .35,
      notes: "Modo local: sugestao gerada sem backend de IA. Revise antes de salvar."
    });
    document.querySelector("#aiResult").innerHTML = `<div class="result-card"><strong>Cadastro por foto em modo local</strong><p>O servidor de IA nao esta rodando, entao preenchi uma sugestao basica para nao travar o cadastro.</p><p>${escapeHtml(error.message)}</p></div>`;
    toast("Modo local ativado para cadastro por foto");
  }
});

document.querySelector("#eanPhoto").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  const status = document.querySelector("#eanReaderStatus");
  if (!file) return;
  status.textContent = "Lendo codigo de barras...";
  try {
    const ean = await readBarcodeFromImage(file);
    document.querySelector("#itemForm").ean.value = ean;
    status.textContent = `EAN identificado: ${ean}`;
    const duplicate = findDuplicateByEan(ean);
    if (duplicate) toast(`EAN ja cadastrado em ${duplicate.code}`);
    else toast("EAN preenchido pela camera");
  } catch (error) {
    status.textContent = error.message;
    toast("Nao consegui ler o EAN pela foto");
  } finally {
    e.target.value = "";
  }
});

document.querySelector("#itemForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (e.target.dataset.saving === "true") return;
  e.target.dataset.saving = "true";
  const submitButton = e.target.querySelector("button[type='submit']");
  const originalButtonText = submitButton.textContent;
  submitButton.disabled = true;
  submitButton.textContent = isAdmin() ? "Salvando..." : "Enviando...";
  const preview = document.querySelector("#photoPreview");
  try {
    const photo = await fileToDataURL(e.target.photo.files[0]) || (preview.style.display === "block" ? preview.src : "");
    const item = buildItem(e.target, photo);
    item.purchaseInvoiceFileName = e.target.purchaseInvoiceFile.files[0]?.name || "";
    item.purchaseInvoiceFile = await fileToDataURL(e.target.purchaseInvoiceFile.files[0]);
    submitInventoryItem(item);
    e.target.reset();
    document.querySelector("input[name='entryDate']").value = today;
    preview.removeAttribute("src");
    preview.style.display = "none";
    document.querySelector("#aiResult").innerHTML = "";
    document.querySelector("#priceResults").innerHTML = "";
    document.querySelector("#priceQuery").value = "";
    document.querySelector("#eanReaderStatus").textContent = "Use a camera para ler codigo de barras.";
    renderAll();
    showItemSavedConfirmation(item);
    await syncCloudNow(false);
  } finally {
    e.target.dataset.saving = "";
    submitButton.disabled = false;
    submitButton.textContent = originalButtonText;
  }
});

function showItemSavedConfirmation(item) {
  const dialog = document.querySelector("#itemSavedDialog");
  const body = document.querySelector("#itemSavedBody");
  if (!dialog || !body) return;
  const adminText = isAdmin()
    ? "O item foi salvo diretamente no estoque."
    : "O item foi enviado para validacao do administrador.";
  body.innerHTML = `<strong>${escapeHtml(item.code)} - ${escapeHtml(item.name || "Produto")}</strong><p>${adminText}</p>`;
  dialog.showModal();
}

document.querySelector("#marketBtn").addEventListener("click", async () => {
  const form = document.querySelector("#itemForm");
  const query = `${form.name.value} ${form.brand.value} ${form.model.value}`.trim();
  if (!query) return toast("Informe nome, marca ou modelo para pesquisar");
  const prices = await renderPriceResult(document.querySelector("#priceResults"), query);
  form.marketValue.value = prices.avg.toFixed(2);
  form.suggestedValue.value = (prices.avg * .92).toFixed(2);
  form.saleValue.value = (prices.avg * .95).toFixed(2);
  document.querySelector("#priceQuery").value = query;
  toast("Preco sugerido preenchido para revisao");
});

document.querySelector("#scrapForm").addEventListener("input", updateScrapPreview);
document.querySelector("#scrapForm").addEventListener("submit", (e) => {
  e.preventDefault();
  if (!isAdmin()) return toast("Apenas administrador cadastra sucata direta");
  const data = Object.fromEntries(new FormData(e.target).entries());
  const weight = num(data.weight);
  const paid = weight * num(data.paidPerKg);
  const sell = weight * num(data.sellPerKg);
  submitInventoryItem({
    id: crypto.randomUUID(), code: code(), photo: "", ean: "", name: `Sucata de ${data.material}`,
    category: "Sucata", subcategory: data.material, brand: "", model: "",
    quantity: 1, weight, condition: "sucata", paidValue: paid, marketValue: sell,
    suggestedValue: sell, saleValue: sell, location: "", entryDate: today,
    status: "em estoque", adLink: "", notes: `Valor pago/kg: ${data.paidPerKg}. Venda/kg: ${data.sellPerKg}.`,
    validationStatus: "approved"
  });
  e.target.reset();
  updateScrapPreview();
});

function updateScrapPreview() {
  const form = document.querySelector("#scrapForm");
  const data = Object.fromEntries(new FormData(form).entries());
  const paid = num(data.weight) * num(data.paidPerKg);
  const sell = num(data.weight) * num(data.sellPerKg);
  document.querySelector("#scrapPreview").innerHTML = `<div class="calc-card">Total pago: <strong>${money.format(paid)}</strong> Venda estimada: <strong>${money.format(sell)}</strong> Lucro estimado: <strong>${money.format(sell - paid)}</strong></div>`;
}

document.querySelector("#priceSearch").addEventListener("click", async () => {
  const query = document.querySelector("#priceQuery").value.trim();
  if (!query) return toast("Digite um produto para pesquisar");
  await renderPriceResult(document.querySelector("#priceResults"), query);
});

document.querySelector("#saleForm").addEventListener("input", updateSalePreview);
document.querySelector("input[name='unitSaleValue']").addEventListener("input", (event) => {
  event.target.dataset.saleUnitMode = "manual";
});
document.querySelector("#saleItem").addEventListener("change", () => {
  document.querySelector("input[name='unitSaleValue']").dataset.saleUnitMode = "auto";
  syncSaleUnitValue(true);
  renderSaleItemPreview();
  updateSaleMeasureUI();
  updateSalePreview();
});
document.querySelector("input[name='seller']").addEventListener("change", () => {
  const form = document.querySelector("#saleForm");
  const seller = state.contacts.find(contact => contact.type === "Vendedor" && contact.name === form.seller.value);
  if (seller && seller.cashbackPercent !== "") form.cashbackPercent.value = seller.cashbackPercent;
  updateCashbackBalanceInfo();
  updateSalePreview();
});
document.querySelector("input[name='customer']").addEventListener("change", () => {
  const form = document.querySelector("#saleForm");
  const seller = state.contacts.find(contact => contact.type === "Vendedor" && contact.name.trim().toLowerCase() === form.customer.value.trim().toLowerCase());
  if (seller && !form.seller.value) form.seller.value = seller.name;
  if (seller && seller.cashbackPercent !== "") form.cashbackPercent.value = seller.cashbackPercent;
  updateCashbackBalanceInfo();
  updateSalePreview();
});
document.querySelector("input[name='cashbackUsed']").addEventListener("input", () => {
  updateCashbackBalanceInfo();
  updateSalePreview();
});
document.querySelector("#addSaleItemBtn")?.addEventListener("click", addCurrentItemToSaleCart);
document.querySelector("#saleForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (e.target.dataset.saving === "true") return;
  e.target.dataset.saving = "true";
  const submitButton = e.target.querySelector("button[type='submit']");
  const originalButtonText = submitButton?.textContent || "Finalizar venda";
  if (submitButton) {
    submitButton.disabled = true;
    submitButton.textContent = "Salvando venda...";
  }
  try {
  const data = Object.fromEntries(new FormData(e.target).entries());
  if (!saleCart.length) {
    const line = currentSaleLineFromForm();
    if (!line) return toast("Nenhum item selecionado");
    if (line.error) return toast(line.error);
    saleCart.push(line);
    renderSaleCart();
  }
  const registeredCustomer = findRegisteredCustomer(data.customer);
  if (!registeredCustomer) return toast("Venda bloqueada: cliente precisa estar cadastrado");
  const soldTotal = sum(saleCart, line => line.soldValue);
  const profitTotal = sum(saleCart, line => line.profit);
  const soldWeightTotal = sum(saleCart, line => line.soldWeight);
  const soldQuantityTotal = sum(saleCart, line => line.soldQuantity);
  const cashbackAccount = registeredCustomer.type === "Vendedor" ? registeredCustomer.name : data.seller;
  const cashbackUsed = num(data.cashbackUsed);
  const paidNow = num(data.paidNow);
  const cardFee = num(data.cardFee);
  if (cashbackUsed > soldTotal) return toast("Cashback nao pode ser maior que o valor da venda");
  const sellerBalance = getSellerCashbackBalance(cashbackAccount);
  if (cashbackUsed > 0 && cashbackUsed > sellerBalance) return toast("Cashback usado maior que o saldo do vendedor");
  const paymentTotal = cashbackUsed + paidNow;
  const balanceOpen = Math.max(0, soldTotal - paymentTotal);
  if (paymentTotal > soldTotal) return toast("Pagamento + cashback maior que o valor da venda");
  if (balanceOpen > 0 && !String(data.balancePayment || data.payment || "").trim()) {
    return toast("Informe como sera pago o saldo restante da venda");
  }
  if (balanceOpen > 0 && !data.dueDate) return toast("Informe o vencimento do saldo restante");
  if (cashbackUsed > 0 && cashbackUsed >= soldTotal && !String(data.payment || "").trim()) {
    data.payment = "Cashback";
  }
  const generatesCashback = !(registeredCustomer.type === "Vendedor" && cashbackUsed > 0);
  const cashbackValue = generatesCashback ? soldTotal * (num(data.cashbackPercent) / 100) : 0;
  if (editingSaleId) return toast("Use a janela de edicao da venda para alterar registros existentes");
  const sale = {
    id: crypto.randomUUID(),
    ...data,
    itemId: saleCart[0]?.itemId,
    items: saleCart.map(line => ({ ...line })),
    status: "concluida",
    soldWeight: soldWeightTotal,
    soldQuantity: soldQuantityTotal,
    soldValue: soldTotal,
    profit: profitTotal,
    cashbackPercent: num(data.cashbackPercent),
    cashbackValue,
    cashbackUsed,
    paidNow,
    cardFee,
    balanceOpen,
    paymentStatus: balanceOpen <= 0 ? "Paga" : paymentTotal > 0 ? "Parcialmente paga" : "Pendente",
    cashbackAccount,
    cashbackBlockedReason: generatesCashback ? "" : "Compra paga com cashback nao gera novo cashback"
  };
  stampCreate(sale);
  state.sales.unshift(sale);
  saleCart.forEach(line => {
    const item = state.items.find(product => product.id === line.itemId);
    if (!item) return;
    if (line.soldWeight) {
      item.weight = Math.max(0, num(item.weight) - num(line.soldWeight));
      item.quantity = item.weight > 0 ? 1 : 0;
      item.paidValue = Math.max(0, num(item.paidValue) - num(line.cost));
    } else {
      item.quantity = Math.max(0, num(item.quantity) - num(line.soldQuantity));
    }
    if (num(item.quantity) <= 0 || (item.category === "Sucata" && num(item.weight) <= 0)) item.status = "vendido";
    item.soldAt = data.soldAt;
    item.finalSoldValue = num(item.finalSoldValue) + num(line.soldValue);
    item.customer = data.customer;
    item.channel = data.channel;
    stampUpdate(item);
  });
  if (data.invoiceEnabled === "sim") {
    state.invoices.unshift(stampCreate({
      id: crypto.randomUUID(),
      saleId: sale.id,
      number: data.invoiceNumber || `NF-${String(state.invoices.length + 1).padStart(4, "0")}`,
      document: data.invoiceDocument,
      issuedAt: data.soldAt,
      value: sale.soldValue,
      status: data.invoiceStatus,
      notes: data.invoiceNotes,
    }));
  }
  const receivable = upsertReceivableFromSale(sale);
  save();
  await syncCloudNow(false);
  saleCart = [];
  e.target.reset();
  e.target.unitSaleValue.dataset.saleUnitMode = "auto";
  document.querySelector("input[name='soldAt']").value = today;
  updateSaleMeasureUI();
  renderSaleCart();
  updateCashbackBalanceInfo();
  const message = receivable
    ? `Venda concluida. Cashback aplicado: ${money.format(cashbackUsed)}. Saldo restante: ${money.format(balanceOpen)}. Conta a receber criada.`
    : `Venda concluida. Pago: ${money.format(paymentTotal)}. Lucro ${money.format(sale.profit)}`;
  toast(message);
  } finally {
    e.target.dataset.saving = "";
    if (submitButton) {
      submitButton.disabled = false;
      submitButton.textContent = originalButtonText;
    }
  }
});

function updateSalePreview() {
  const form = document.querySelector("#saleForm");
  const item = state.items.find(i => i.id === form.itemId.value);
  if (!item) {
    document.querySelector("#salePreview").innerHTML = "";
    renderSaleItemPreview();
    return;
  }
  const isScrap = item.category === "Sucata";
  updateSaleMeasureUI();
  syncSaleUnitValue();
  const soldMeasure = num(form.soldMeasure.value);
  const soldWeight = isScrap ? soldMeasure : 0;
  const soldQuantity = isScrap ? 0 : (soldMeasure || 1);
  const costBase = isScrap && num(item.weight)
    ? num(item.paidValue) * (soldWeight / num(item.weight))
    : num(item.paidValue) * (soldQuantity / Math.max(num(item.quantity), 1));
  const stockText = isScrap ? `Disponivel: ${num(item.weight)} kg` : `Disponivel: ${num(item.quantity)} un.`;
  const measure = isScrap ? soldWeight : soldQuantity;
  if (num(form.unitSaleValue.value) && measure) {
    form.soldValue.value = (num(form.unitSaleValue.value) * measure).toFixed(2);
  }
  const profit = num(form.soldValue.value) - costBase;
  const available = isScrap ? num(item.weight) : num(item.quantity);
  const unitLabel = isScrap ? "kg" : "un.";
  const unitCost = available ? num(item.paidValue) / available : 0;
  const unitReference = saleUnitReference(item);
  const unitSale = num(form.unitSaleValue.value) || (measure ? num(form.soldValue.value) / measure : 0);
  const unitProfit = unitSale - unitCost;
  document.querySelector("#salePreview").innerHTML = `
    <div class="sale-summary">
      <div><span>Disponivel</span><strong>${stockText.replace("Disponivel: ", "")}</strong></div>
      <div><span>Valor cadastrado por ${unitLabel}</span><strong>${money.format(unitReference)}</strong></div>
      <div><span>Custo por ${unitLabel}</span><strong>${money.format(unitCost)}</strong></div>
      <div><span>Venda por ${unitLabel}</span><strong>${money.format(unitSale)}</strong></div>
      <div><span>Lucro por ${unitLabel}</span><strong>${money.format(unitProfit)}</strong></div>
      <div><span>Custo proporcional</span><strong>${money.format(costBase)}</strong></div>
      <div><span>Lucro total previsto</span><strong>${money.format(profit)}</strong></div>
    </div>`;
  updateCashbackBalanceInfo();
}

function updateSaleEditPreview() {
  const form = document.querySelector("#saleEditForm");
  if (!form) return;
  const sale = state.sales.find(entry => entry.id === editingSaleId);
  const item = state.items.find(i => i.id === form.itemId.value);
  if (!sale || !item) {
    document.querySelector("#saleEditPreview").innerHTML = "";
    return;
  }
  const isScrap = item.category === "Sucata";
  document.querySelector("#saleEditMeasureLabel").firstChild.textContent = isScrap ? "Kg vendido" : "Quantidade vendida";
  document.querySelector("#saleEditMeasureUnit").textContent = isScrap ? "kg" : "un.";
  document.querySelector("#saleEditUnitLabel").firstChild.textContent = isScrap ? "Valor por kg" : "Valor por unidade";
  form.soldMeasure.step = isScrap ? "0.01" : "1";
  const measure = num(form.soldMeasure.value) || 1;
  if (num(form.unitSaleValue.value) && measure) {
    form.soldValue.value = (num(form.unitSaleValue.value) * measure).toFixed(2);
  }
  const originalMeasure = num(sale.soldWeight) || num(sale.soldQuantity) || 1;
  const originalCost = num(sale.soldValue) - num(sale.profit);
  const costBase = originalMeasure ? originalCost * (measure / originalMeasure) : originalCost;
  const profit = num(form.soldValue.value) - costBase;
  const unitLabel = isScrap ? "kg" : "un.";
  const unitSale = num(form.unitSaleValue.value) || (measure ? num(form.soldValue.value) / measure : 0);
  document.querySelector("#saleEditPreview").innerHTML = `<div class="sale-summary">
    <div><span>Venda por ${unitLabel}</span><strong>${money.format(unitSale)}</strong></div>
    <div><span>Custo proporcional</span><strong>${money.format(costBase)}</strong></div>
    <div><span>Lucro previsto</span><strong>${money.format(profit)}</strong></div>
  </div>`;
}

async function saveSaleEdit(form) {
  const sale = state.sales.find(entry => entry.id === editingSaleId);
  if (!sale) return;
  const data = Object.fromEntries(new FormData(form).entries());
  const item = state.items.find(i => i.id === data.itemId);
  if (!item) return toast("Nenhum item selecionado");
  const registeredCustomer = findRegisteredCustomer(data.customer);
  if (!registeredCustomer) return toast("Venda bloqueada: cliente precisa estar cadastrado");
  const isScrap = item.category === "Sucata";
  const soldMeasure = num(data.soldMeasure);
  const soldWeight = isScrap ? soldMeasure : 0;
  const soldQuantity = isScrap ? 0 : (soldMeasure || 1);
  if (isScrap && soldWeight <= 0) return toast("Informe quantos kg de sucata foram vendidos");
  if (!isScrap && soldQuantity <= 0) return toast("Informe a quantidade vendida");
  const cashbackAccount = registeredCustomer.type === "Vendedor" ? registeredCustomer.name : data.seller;
  const cashbackUsed = num(data.cashbackUsed);
  const oldUsedCredit = sale.cashbackAccount === cashbackAccount ? num(sale.cashbackUsed) : 0;
  if (cashbackUsed > 0 && cashbackUsed > getSellerCashbackBalance(cashbackAccount) + oldUsedCredit) {
    return toast("Cashback usado maior que o saldo do vendedor");
  }
  if (cashbackUsed > 0 && cashbackUsed < num(data.soldValue) && !String(data.payment || "").trim()) {
    return toast("Informe como sera pago o saldo restante da venda");
  }
  if (cashbackUsed > 0 && cashbackUsed >= num(data.soldValue) && !String(data.payment || "").trim()) {
    data.payment = "Cashback";
  }
  const generatesCashback = !(registeredCustomer.type === "Vendedor" && cashbackUsed > 0);
  const cashbackValue = generatesCashback ? num(data.soldValue) * (num(data.cashbackPercent) / 100) : 0;
  const paidNow = num(data.paidNow);
  const balanceOpen = Math.max(0, num(data.soldValue) - cashbackUsed - paidNow);
  if (cashbackUsed > num(data.soldValue)) return toast("Cashback nao pode ser maior que o valor da venda");
  if (cashbackUsed + paidNow > num(data.soldValue)) return toast("Pagamento + cashback maior que o valor da venda");
  if (balanceOpen > 0 && !data.dueDate) return toast("Informe o vencimento do saldo restante");
  const originalMeasure = num(sale.soldWeight) || num(sale.soldQuantity) || 1;
  const originalCost = num(sale.soldValue) - num(sale.profit);
  const costBase = originalMeasure ? originalCost * ((soldWeight || soldQuantity || 1) / originalMeasure) : originalCost;
  Object.assign(sale, data, {
    soldWeight,
    soldQuantity: isScrap ? 0 : soldQuantity,
    soldValue: num(data.soldValue),
    profit: num(data.soldValue) - costBase,
    cashbackPercent: num(data.cashbackPercent),
    cashbackValue,
    cashbackUsed,
    paidNow,
    cardFee: num(data.cardFee),
    balanceOpen,
    paymentStatus: balanceOpen <= 0 ? "Paga" : cashbackUsed + paidNow > 0 ? "Parcialmente paga" : "Pendente",
    cashbackAccount,
    cashbackBlockedReason: generatesCashback ? "" : "Compra paga com cashback nao gera novo cashback",
    updatedAt: new Date().toISOString(),
    updatedBy: currentUsername()
  });
  let invoice = state.invoices.find(note => note.saleId === sale.id);
  if (data.invoiceEnabled === "sim" && !invoice) {
    invoice = stampCreate({ id: crypto.randomUUID(), saleId: sale.id });
    state.invoices.unshift(invoice);
  }
  if (invoice) {
    invoice.number = data.invoiceNumber || invoice.number || `NF-${String(state.invoices.length + 1).padStart(4, "0")}`;
    invoice.document = data.invoiceDocument || "";
    invoice.value = sale.soldValue;
    invoice.status = data.invoiceStatus || "pendente";
    invoice.notes = data.invoiceNotes || "";
    invoice.customer = sale.customer;
    stampUpdate(invoice);
  }
  upsertReceivableFromSale(sale);
  editingSaleId = "";
  save();
  await syncCloudNow(false);
  document.querySelector("#saleEditDialog").close();
  renderAll();
  openSale(sale.id);
  toast("Venda atualizada");
}

function saleUnitReference(item) {
  if (!item) return 0;
  const reference = num(item.saleValue) || num(item.suggestedValue) || num(item.marketValue);
  if (item.category !== "Sucata") return reference;
  const weight = num(item.weight);
  if (weight && reference > 0 && num(item.paidValue) > 0 && reference > num(item.paidValue)) return reference / weight;
  return reference;
}

function syncSaleUnitValue(force = false) {
  const form = document.querySelector("#saleForm");
  const item = state.items.find(i => i.id === form.itemId.value);
  const reference = saleUnitReference(item);
  if (!item || !reference) return;
  const input = form.unitSaleValue;
  const canAutoFill = force || !input.value || input.dataset.saleUnitMode === "auto";
  if (!canAutoFill) return;
  input.value = reference.toFixed(2);
  input.dataset.saleUnitMode = "auto";
}

function updateSaleMeasureUI() {
  const form = document.querySelector("#saleForm");
  const item = state.items.find(i => i.id === form.itemId.value);
  const isScrap = item?.category === "Sucata";
  document.querySelector("#saleMeasureLabel").firstChild.textContent = isScrap ? "Kg vendido" : "Quantidade vendida";
  document.querySelector("#saleMeasureUnit").textContent = isScrap ? "kg" : "un.";
  document.querySelector("#unitSaleLabel").firstChild.textContent = isScrap ? "Valor por kg" : "Valor por unidade";
  form.soldMeasure.step = isScrap ? "0.01" : "1";
  form.soldMeasure.placeholder = isScrap ? `Disponivel: ${num(item?.weight)} kg` : `Disponivel: ${num(item?.quantity)} un.`;
}

document.querySelector("#invoiceForm")?.addEventListener("submit", (e) => {
  e.preventDefault();
});

document.querySelector("#stockSearch").addEventListener("input", renderStock);
document.querySelector("#stockCategory").addEventListener("change", renderStock);

document.querySelector("#userForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!isAdmin()) return toast("Apenas administrador pode criar usuarios");
  if (e.target.dataset.saving === "true") return;
  e.target.dataset.saving = "true";
  const data = Object.fromEntries(new FormData(e.target).entries());
  const username = data.username.trim();
  try {
    if (!username || !data.password) return toast("Informe usuario e senha");
    if (editingUserId) {
      const user = state.users.find(item => item.id === editingUserId);
      if (!user) return toast("Usuario nao encontrado");
      const adminCount = state.users.filter(item => item.role === "admin").length;
      if (user.role === "admin" && data.role !== "admin" && adminCount <= 1) return toast("Mantenha pelo menos um administrador");
      if (state.users.some(item => item.username === username && item.id !== editingUserId)) return toast("Usuario ja existe");
      Object.assign(user, { username, password: data.password, role: data.role });
      stampUpdate(user);
      if (getCurrentUser()?.id === editingUserId) sessionStorage.setItem(AUTH_KEY, username);
      editingUserId = "";
      e.target.querySelector("button[type='submit']").textContent = "Adicionar usuario";
      toast("Usuario atualizado");
    } else {
      if (state.users.some(user => user.username === username)) return toast("Usuario ja existe");
      state.users.push(stampCreate({ id: crypto.randomUUID(), username, password: data.password, role: data.role }));
      toast(data.role === "colaborador" ? "Colaborador adicionado" : "Administrador adicionado");
    }
    e.target.reset();
    save({ skipRender: true });
    await syncCloudNow(false);
    renderAll();
  } finally {
    e.target.dataset.saving = "";
  }
});

document.querySelector("#contactForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (e.target.dataset.saving === "true") return;
  e.target.dataset.saving = "true";
  const data = Object.fromEntries(new FormData(e.target).entries());
  if (data.type === "Vendedor" && data.cashbackPercent === "") {
    e.target.dataset.saving = "";
    return toast("Informe o percentual de cashback do vendedor");
  }
  data.cashbackPercent = data.type === "Vendedor" ? num(data.cashbackPercent) : "";
  const contactId = editingContactId || e.target.dataset.editingId || "";
  if (contactId) {
    const contact = state.contacts.find(item => item.id === contactId);
    if (!contact) {
      e.target.dataset.saving = "";
      return toast("Cadastro nao encontrado para editar");
    }
    Object.assign(contact, data);
    stampUpdate(contact);
    editingContactId = "";
    e.target.dataset.editingId = "";
    e.target.querySelector("button[type='submit']").textContent = "Salvar cadastro";
    toast("Cadastro atualizado");
  } else {
    state.contacts.unshift(stampCreate({
      id: crypto.randomUUID(),
      ...data
    }));
    toast("Cliente / fornecedor salvo");
  }
  save({ skipRender: true });
  const synced = await syncCloudNow(false);
  renderAll();
  if (!synced) {
    e.target.dataset.saving = "";
    return;
  }
  e.target.reset();
  setTimeout(() => {
    e.target.dataset.saving = "";
  }, 300);
});

document.querySelector("#saveOpenAiKey").addEventListener("click", () => {
  if (!isAdmin()) return toast("Apenas administrador pode salvar a chave");
  const value = document.querySelector("#openaiKey").value.trim();
  if (!value) return toast("Informe a chave da OpenAI");
  localStorage.setItem(OPENAI_KEY, value);
  toast("Chave da IA salva");
});

document.querySelector("#removeOpenAiKey").addEventListener("click", () => {
  if (!isAdmin()) return toast("Apenas administrador pode remover a chave");
  localStorage.removeItem(OPENAI_KEY);
  document.querySelector("#openaiKey").value = "";
  toast("Chave da IA removida");
});

document.querySelector("#syncCloudBtn")?.addEventListener("click", () => {
  syncCloudNow(true);
});

document.querySelector("#closeItemSavedDialog")?.addEventListener("click", () => {
  document.querySelector("#itemSavedDialog")?.close();
});

document.querySelector("#newItemAfterSave")?.addEventListener("click", () => {
  document.querySelector("#itemSavedDialog")?.close();
  switchView("cadastro");
  document.querySelector("#itemForm")?.querySelector("input[name='name']")?.focus();
});

document.querySelector("#seedBtn")?.addEventListener("click", async () => {
  await syncCloudNow(false);
  localStorage.setItem(MODE_KEY, "demo");
  const currentUsers = state.users?.length ? state.users : DEFAULT_USERS;
  Object.keys(state).forEach(key => delete state[key]);
  Object.assign(state, blankState(currentUsers));
  state.items = [
    { id: crypto.randomUUID(), code: "UNI-0001", ean: "7891000000011", name: "Motor WEG 2CV usado", category: "PeÃ§a usada", subcategory: "Motor", brand: "WEG", model: "2CV", quantity: 1, weight: 18, condition: "funcionando", paidValue: 260, marketValue: 720, suggestedValue: 650, saleValue: 690, location: "Galpao A / Prateleira 2", entryDate: "2026-01-20", status: "anunciado", adLink: "", notes: "", photo: "", createdAt: new Date().toISOString(), validationStatus: "approved", createdBy: "admin" },
    { id: crypto.randomUUID(), code: "UNI-0002", ean: "7891000000028", name: "Sucata de cobre limpo", category: "Sucata", subcategory: "cobre", brand: "", model: "", quantity: 1, weight: 42, condition: "sucata", paidValue: 1260, marketValue: 1596, suggestedValue: 1596, saleValue: 1596, location: "Container 1", entryDate: "2025-11-05", status: "em estoque", adLink: "", notes: "", photo: "", createdAt: new Date().toISOString(), validationStatus: "approved", createdBy: "admin" },
    { id: crypto.randomUUID(), code: "UNI-0003", ean: "7891000000035", name: "Compressor para revenda", category: "Produto de revenda", subcategory: "Compressor", brand: "Schulz", model: "MSV", quantity: 1, weight: 33, condition: "usado", paidValue: 480, marketValue: 980, suggestedValue: 900, saleValue: 930, location: "", entryDate: "2026-04-12", status: "em estoque", adLink: "", notes: "", photo: "", createdAt: new Date().toISOString(), validationStatus: "approved", createdBy: "admin" }
  ];
  state.sequence = 4;
  save();
  switchView("dashboard");
  toast("Modo demonstracao carregado");
});

document.querySelector("#mainDataBtn")?.addEventListener("click", async () => {
  await setMode("main");
  toast("Sistema principal carregado");
});

document.querySelector("#exportStockBtn").addEventListener("click", () => {
  exportTable("estoque-uniglobal.xls", state.items.filter(item => item.status !== "vendido" && item.status !== "descartado" && item.status !== "excluido").map(item => ({
    codigo: item.code,
    ean: item.ean,
    nome: item.name,
    categoria: item.category,
    subcategoria: item.subcategory,
    marca: item.brand,
    modelo: item.model,
    quantidade: item.quantity,
    peso_kg: item.weight,
    estado: item.condition,
    valor_pago: item.paidValue,
    valor_mercado: item.marketValue,
    valor_sugerido: item.suggestedValue,
    valor_venda: item.saleValue,
    fornecedor: item.supplier,
    nf_compra: item.purchaseInvoice,
    data_compra: item.purchaseDate,
    chave_nf_compra: item.purchaseInvoiceKey,
    arquivo_nf_compra: item.purchaseInvoiceFileName,
    localizacao: item.location,
    entrada: item.entryDate,
    status: item.status,
    anuncio: item.adLink,
    observacoes: item.notes
  })));
});

document.querySelector("#exportSalesBtn").addEventListener("click", () => {
  exportTable("vendas-uniglobal.xls", state.sales.map(sale => {
    const item = state.items.find(product => product.id === sale.itemId) || {};
    return {
      codigo: item.code,
      ean: item.ean,
      produto: item.name,
      data_venda: sale.soldAt,
      valor_vendido: sale.soldValue,
      cliente: sale.customer,
      pagamento: sale.payment,
      canal: sale.channel,
      lucro: sale.profit
    };
  }));
});

document.querySelector("#exportProductsInventory")?.addEventListener("click", () => {
  exportTable("inventario-produtos-uniglobal.xls", productInventoryRows().map(row => ({
    tipo: row.tipo,
    data: row.data,
    codigo: row.codigo,
    ean: row.ean,
    produto: row.produto,
    categoria: row.categoria,
    cliente: row.cliente,
    vendedor: row.vendedor,
    medida: row.medida,
    valor: row.valor,
    lucro: row.lucro,
    status: row.status,
    motivo: row.motivo,
    rastreabilidade: row.rastreabilidade
  })));
});

document.querySelector("#printProductsInventory")?.addEventListener("click", () => {
  window.print();
});

document.querySelector("#productEditForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const item = saveActiveProduct();
  if (!item) return;
  save();
  renderAll();
  await syncCloudNow(false);
  document.querySelector("#productDialog").close();
  toast("Produto atualizado");
});

document.querySelector("#approveFromDialog").addEventListener("click", async () => {
  const item = saveActiveProduct();
  if (!item) return;
  save();
  document.querySelector("#productDialog").close();
  approvePendingItem(item.id);
  await syncCloudNow(false);
});

document.querySelector("#rejectFromDialog").addEventListener("click", async () => {
  if (!activeProduct || activeProduct.source !== "pending") return;
  const item = saveActiveProduct();
  if (!item) return;
  const reason = prompt("Motivo para rejeitar o produto:");
  if (reason === null) return;
  document.querySelector("#productDialog").close();
  rejectPendingItem(item.id, reason.trim() || "Rejeitado pelo administrador");
  await syncCloudNow(false);
});

document.querySelector("#deleteProductFromDialog").addEventListener("click", async () => {
  if (!activeProduct || activeProduct.source !== "stock") return;
  deleteStockProduct(activeProduct.id);
  await syncCloudNow(false);
});

document.querySelector("#dialogMarketBtn").addEventListener("click", async () => {
  const item = saveActiveProduct();
  if (!item) return;
  const query = `${item.name || ""} ${item.brand || ""} ${item.model || ""}`.trim();
  if (!query) return toast("Informe nome, marca ou modelo para pesquisar");
  const prices = await renderPriceResult(document.querySelector("#dialogPriceResults"), query);
  item.marketValue = prices.avg;
  item.suggestedValue = Number((prices.avg * .92).toFixed(2));
  item.saleValue = Number((prices.avg * .95).toFixed(2));
  const form = document.querySelector("#productEditForm");
  form.marketValue && (form.marketValue.value = item.marketValue);
  form.suggestedValue.value = item.suggestedValue;
  form.saleValue.value = item.saleValue;
  save();
  toast("Preco pesquisado e valores atualizados");
});

document.querySelector("#closeProductDialog").addEventListener("click", () => {
  document.querySelector("#productDialog").close();
});

document.querySelector("#closeContactDialog").addEventListener("click", () => {
  document.querySelector("#contactDialog").close();
});

document.querySelector("#editContactFromDialog").addEventListener("click", () => {
  if (activeContactId) editContact(activeContactId);
});

document.querySelector("#deleteContactFromDialog").addEventListener("click", () => {
  if (activeContactId) deleteContact(activeContactId);
});

document.querySelector("#closeSaleDialog").addEventListener("click", () => {
  document.querySelector("#saleDialog").close();
});

document.querySelector("#closeDashboardDrill").addEventListener("click", () => {
  document.querySelector("#dashboardDrillDialog").close();
});

document.querySelector("#closeSellerDialog").addEventListener("click", () => {
  document.querySelector("#sellerDialog").close();
});

document.querySelector("#cancelSaleFromDialog").addEventListener("click", () => {
  if (!activeSaleId) return;
  document.querySelector("#saleDialog").close();
  reverseSale(activeSaleId, "cancelada");
});

document.querySelector("#refundSaleFromDialog").addEventListener("click", () => {
  if (!activeSaleId) return;
  document.querySelector("#saleDialog").close();
  reverseSale(activeSaleId, "estornada");
});

document.querySelector("#printSalePdf").addEventListener("click", () => {
  if (activeSaleId) printSale(activeSaleId);
});

document.querySelector("#editSaleFromDialog").addEventListener("click", () => {
  if (activeSaleId) editSale(activeSaleId);
});

document.querySelector("#closeSaleEditDialog").addEventListener("click", () => {
  editingSaleId = "";
  document.querySelector("#saleEditDialog").close();
});

document.querySelector("#cancelSaleEdit").addEventListener("click", () => {
  editingSaleId = "";
  document.querySelector("#saleEditDialog").close();
});

document.querySelector("#saleEditForm").addEventListener("input", updateSaleEditPreview);

document.querySelector("#saleEditForm input[name='seller']").addEventListener("change", () => {
  const form = document.querySelector("#saleEditForm");
  const seller = state.contacts.find(contact => contact.type === "Vendedor" && contact.name === form.seller.value);
  if (seller && seller.cashbackPercent !== "") form.cashbackPercent.value = seller.cashbackPercent;
  updateSaleEditPreview();
});

document.querySelector("#saleEditForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  await saveSaleEdit(event.target);
});

updateScrapPreview();
applyPermissions();
render();
(async function startApp() {
  if (getCurrentUser()) {
    await loadCloudState();
    unlockApp();
  } else {
    lockApp();
  }
})();

