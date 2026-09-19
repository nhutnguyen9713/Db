/* ============ kiểm tra thư viện ngoài (SheetJS/XLSX) có tải được không ============ */
const LIB_XLSX_OK = typeof XLSX !== 'undefined';

/* ============================================================
   ============  FileVault: lưu TOÀN BỘ trạng thái vào 1 FILE  ============
   ============  trên máy — KHÔNG dùng localStorage             ============
   ============================================================
   - "Chọn file đồng bộ": chọn/tạo 1 file .json trên máy; từ đó mọi thay đổi
     (tồn kho, Plan, đã xác nhận, Transaction, Master, So sánh ERP/WMS, giao
     diện...) tự động được ghi vào file này (debounce ~400ms).
   - Khi mở lại trang, tự kết nối lại file đã chọn trước đó (qua IndexedDB
     lưu tay cầm file) và đọc trạng thái từ đó lên.
   - "Xuất JSON / Nhập JSON": phương án dự phòng — tải trạng thái ra 1 file
     JSON để backup/chuyển máy, hoặc nạp lại từ 1 file JSON đã xuất.
   - Mọi module bên dưới vẫn gọi LS.getItem/setItem/removeItem như cũ (API
     giống localStorage), nhưng dữ liệu thật sự được giữ trong bộ nhớ tạm
     (_mem) và đồng bộ ra file — không còn phụ thuộc LS. */
const FV_DB_NAME = 'tn5_filevault_db';
const FV_STORE = 'handles';
const FV_HANDLE_KEY = 'syncFileHandle';

function fvIdbOpen(){
  return new Promise((resolve, reject) => {
    try{
      const req = indexedDB.open(FV_DB_NAME, 1);
      req.onupgradeneeded = () => { req.result.createObjectStore(FV_STORE); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }catch(e){ reject(e); }
  });
}
async function fvIdbGet(key){
  try{
    const db = await fvIdbOpen();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(FV_STORE, 'readonly');
      const req = tx.objectStore(FV_STORE).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }catch(e){ return null; }
}
async function fvIdbSet(key, val){
  try{
    const db = await fvIdbOpen();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(FV_STORE, 'readwrite');
      tx.objectStore(FV_STORE).put(val, key);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
  }catch(e){ return false; }
}

/* ============ Bản sao lưu cục bộ CỠ LỚN bằng IndexedDB (bổ sung cho localStorage) ============
   localStorage giới hạn ~5-10MB/domain — với dữ liệu tồn kho + lịch sử tích luỹ lâu ngày có thể VƯỢT
   hạn mức này (ghi bị lặng lẽ thất bại, xem catch trong tn5PersistMemToLocalBackup), khiến máy phải
   phụ thuộc HOÀN TOÀN vào tải lại từ Cloud mỗi lần mở trang dù dữ liệu chưa đổi gì — tốn băng thông
   Firebase (free tier chỉ 10GB/tháng). IndexedDB không có giới hạn nhỏ như vậy nên dùng làm bản sao
   lưu ĐẦY ĐỦ hơn — BỔ SUNG cho bản sao lưu localStorage hiện có (không thay thế), mỗi bản là 1 lớp
   dự phòng độc lập; xem tn5SeedMemFromLocalBackup() để rõ cách 2 lớp này kết hợp lúc khởi động. */
const SC_DB_NAME = 'tn5_statecache_db';
const SC_STORE = 'mem';
function scIdbOpen(){
  return new Promise((resolve, reject) => {
    try{
      const req = indexedDB.open(SC_DB_NAME, 1);
      req.onupgradeneeded = () => { req.result.createObjectStore(SC_STORE); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }catch(e){ reject(e); }
  });
}
async function scIdbSetKey(key, val){
  try{
    const db = await scIdbOpen();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(SC_STORE, 'readwrite');
      tx.objectStore(SC_STORE).put(val, key);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
  }catch(e){ return false; }
}
async function scIdbDeleteKey(key){
  try{
    const db = await scIdbOpen();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(SC_STORE, 'readwrite');
      tx.objectStore(SC_STORE).delete(key);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
  }catch(e){ return false; }
}
async function scIdbGetAll(){
  try{
    const db = await scIdbOpen();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(SC_STORE, 'readonly');
      const store = tx.objectStore(SC_STORE);
      const keysReq = store.getAllKeys();
      const valsReq = store.getAll();
      tx.oncomplete = () => {
        const out = {};
        const keys = keysReq.result || [];
        const vals = valsReq.result || [];
        keys.forEach((k, i) => { out[k] = vals[i]; });
        resolve(out);
      };
      tx.onerror = () => reject(tx.error);
    });
  }catch(e){ return {}; }
}

// Bộ nhớ tạm thay cho localStorage — mọi module dùng LS.getItem/setItem/removeItem như cũ
const _mem = {};
// Tiền tố khoá localStorage THẬT của trình duyệt, dùng làm BẢN SAO LƯU CỤC BỘ của _mem — trước đây
// _mem chỉ tồn tại trong bộ nhớ tạm (mất khi đóng tab), toàn bộ dữ liệu (tồn kho, Plan, đã xác nhận…)
// phải phụ thuộc HOÀN TOÀN vào Cloud/File mỗi lần mở lại trang, không có gì dự phòng ở máy nếu Cloud
// lỗi/chậm/mạng rớt. Giờ mọi thay đổi cũng được ghi thêm 1 bản y hệt vào localStorage thật của trình
// duyệt này, và được nạp lại làm bản nền NGAY khi mở trang (trước khi Cloud/File kịp phản hồi) — nếu
// Cloud đọc lỗi/chậm, người dùng vẫn thấy đúng dữ liệu gần nhất máy này từng có, không bị trắng trơn.
const TN5_LOCAL_BACKUP_PREFIX = 'tn5_local_';
function tn5SeedMemFromLocalBackup(){
  try{
    for(let i = 0; i < localStorage.length; i++){
      const lsKey = localStorage.key(i);
      if(lsKey && lsKey.indexOf(TN5_LOCAL_BACKUP_PREFIX) === 0){
        _mem[lsKey.slice(TN5_LOCAL_BACKUP_PREFIX.length)] = localStorage.getItem(lsKey);
      }
    }
  }catch(e){ console.warn('Không đọc được bản sao lưu cục bộ trong trình duyệt:', e); }
}
function tn5PersistMemToLocalBackup(){
  try{
    Object.keys(_mem).forEach(k => localStorage.setItem(TN5_LOCAL_BACKUP_PREFIX + k, _mem[k]));
  }catch(e){ console.warn('Không ghi được bản sao lưu cục bộ vào trình duyệt (có thể do đầy dung lượng):', e); }
  // Bản sao lưu IndexedDB (không giới hạn nhỏ như localStorage) — ghi bất đồng bộ, không chặn luồng
  // chính; lỗi (nếu có) đã được nuốt bên trong scIdbSetKey.
  Object.keys(_mem).forEach(k => scIdbSetKey(k, _mem[k]));
}
// Ghi mốc thời gian đồng bộ ("_meta_updatedAt") — dùng để CloudVault kiểm tra nhanh Cloud có gì mới
// hơn máy này đang cache hay không (chỉ tải vài chục byte) TRƯỚC KHI quyết định có cần tải nguyên
// khối dữ liệu lớn hay không. Cố tình KHÔNG đi qua LS.setItem() vì đây là mốc đồng bộ tự động, không
// phải thay đổi của người dùng — không được làm bật cờ "có thay đổi chưa lưu".
const STORAGE_KEY_META_STAMP = '_meta_updatedAt';
function tn5SetMetaStamp(stamp){
  _mem[STORAGE_KEY_META_STAMP] = String(stamp);
  try{ localStorage.setItem(TN5_LOCAL_BACKUP_PREFIX + STORAGE_KEY_META_STAMP, _mem[STORAGE_KEY_META_STAMP]); }catch(e){}
  scIdbSetKey(STORAGE_KEY_META_STAMP, _mem[STORAGE_KEY_META_STAMP]);
}
tn5SeedMemFromLocalBackup();
// IndexedDB không giới hạn nhỏ như localStorage -> dùng làm lớp phục hồi BỔ SUNG, chạy bất đồng bộ
// SAU khi đã nạp xong bản localStorage (không làm chậm/đổi thứ tự khởi động trang — trang vẫn render
// ngay với dữ liệu localStorage như trước). Chỉ bổ sung những mục localStorage KHÔNG có (VD: từng bị
// lỗi "đầy dung lượng" ở phiên trước) — không bao giờ ghi đè mục đã có sẵn, tránh dùng nhầm bản cũ hơn.
//
// CHỈ chạy khi CHƯA cấu hình Cloud. Lý do (bug đã gặp thật): bước này chạy BẤT ĐỒNG BỘ ngay từ đầu
// trang, chạy ĐUA (race) với bước tải dữ liệu từ Cloud (cũng bất đồng bộ, chạy sau trong file) — nếu
// IndexedDB xong TRƯỚC và còn giữ 1 bản CŨ của 1 mục đã bị xoá hẳn (VD: "Đặt lại toàn bộ" đã xoá khỏi
// localStorage NHƯNG IndexedDB xoá không kịp/không thành công ở phiên nào đó trước đây), mục đó sẽ bị
// "hồi sinh" lại vào _mem — mà bước này KHÔNG cập nhật _meta_updatedAt, nên lần kiểm tra realtime sau
// đó vẫn thấy mốc khớp với Cloud và tưởng nhầm cache cục bộ đang đúng, không tải lại để sửa sai. Khi
// đã có Cloud, Cloud mới là nguồn xác thực — không cần lớp phục hồi cục bộ này nữa (rủi ro hồi sinh
// dữ liệu đã xoá lớn hơn lợi ích phục hồi khi localStorage đầy, vì Cloud tự phục hồi được).
if(!localStorage.getItem('tn5_cloud_gas_url')) scIdbGetAll().then(idbData => {
  const missingKeys = Object.keys(idbData).filter(k => !(k in _mem));
  if(!missingKeys.length) return;
  missingKeys.forEach(k => {
    _mem[k] = idbData[k];
    // Ghi luôn vào bản sao lưu localStorage — để lần mở trang SAU không phải phục hồi lại từ
    // IndexedDB nữa (tránh vẽ lại trang thêm 1 lần mỗi lần mở app), và để 2 lớp sao lưu luôn khớp nhau.
    try{ localStorage.setItem(TN5_LOCAL_BACKUP_PREFIX + k, idbData[k]); }catch(e){}
  });
  console.info('Đã khôi phục thêm ' + missingKeys.length + ' mục từ bản sao lưu IndexedDB (không có trong localStorage): ' + missingKeys.join(', '));
  if(typeof FileVault !== 'undefined' && FileVault._runReloaders) FileVault._runReloaders();
}).catch(e => console.warn('Không đọc được bản sao lưu IndexedDB:', e));
let hasUnsavedChanges = false;
// Tên hiển thị dễ hiểu cho từng loại dữ liệu — dùng để mô tả CHÍNH XÁC vừa thay đổi phần nào,
// thay vì chỉ báo chung chung "có thay đổi chưa lưu".
const STORAGE_KEY_LABELS = {
  tn5_dashboard_inventory_v1: 'Dữ liệu tồn kho',
  tn5_dashboard_plans_v1: 'Plan xuất cont',
  tn5_dashboard_meta_v1: 'Thông tin file đã tải',
  tn5_dashboard_confirmed_v1: 'Danh sách đã xác nhận',
  tn5_dashboard_lastcheck_v1: 'Lần kiểm gần nhất',
  tn5_dashboard_invsnapshot_v1: 'Snapshot tồn kho theo ngày',
  tn5_dashboard_ccresults_v1: 'Đề xuất kiểm hôm nay',
  tn5_dashboard_manual_picked_v1: 'Đánh dấu Pick thủ công',
  tn5_dashboard_hidden_cont_v1: 'Container đã ẩn',
  tn5_dashboard_manual_kho_v1: 'Chọn Kho thủ công',
  tn5_dashboard_spp_ok_v1: 'Tick Đủ hàng SPP thủ công',
  tn5_dashboard_kt_inputs_v1: 'Số liệu KT đang nhập',
  tn5_dashboard_scanned_extra_v1: 'Dòng tự thêm khi quét QR',
  tn5_dashboard_scanned_gi_v1: 'Danh sách GI đã quét',
  tn5_dashboard_gi_scan_log_v1: 'Nhật ký GI đã quét (theo vị trí)',
  tn5_dashboard_cont_ship_v1: 'Dữ liệu Transaction (Ship)',
  tn5_dashboard_item_cbm_v1: 'Thư viện CBM theo mã hàng',
  tn5_dashboard_kho_grid_v1: 'Lưới sơ đồ kho tuỳ chỉnh',
  tn5_dashboard_confirmed_history_v1: 'Lịch sử đã lưu theo ngày',
  _meta_updatedAt: 'Mốc đồng bộ (kiểm tra Cloud có gì mới trước khi tải)'
};

// Gộp nhiều thay đổi xảy ra gần nhau (VD: 1 thao tác ghi luôn nhiều mục cùng lúc) thành ĐÚNG 1 dòng
// thông báo duy nhất, tránh việc chuông thông báo bị spam nhiều dòng cho cùng 1 hành động của người
// dùng.
let _pendingChangedKeys = new Set();
let _pendingChangeTimer = null;
function markUnsavedChanges(key){
  hasUnsavedChanges = true;
  const btn = document.getElementById('btn-save-cloud');
  if(btn) btn.classList.add('has-changes');

  if(key) _pendingChangedKeys.add(key);
  clearTimeout(_pendingChangeTimer);
  _pendingChangeTimer = setTimeout(() => {
    const labels = [..._pendingChangedKeys].map(k => STORAGE_KEY_LABELS[k] || k);
    _pendingChangedKeys.clear();
    const detail = labels.length ? labels.join(', ') : '';
    const statusEl = document.getElementById('upload-status');
    // CHỈ cập nhật đúng 1 nơi (#upload-status) — nút chuông 🔔 đã tự động "nghe" và ghi lại mọi thay
    // đổi của đúng phần tử này vào nhật ký rồi (xem watchStatusElForNotif), nên KHÔNG được gọi thêm
    // logNotification() ở đây nữa — trước đây gọi cả 2 nơi làm cùng 1 sự kiện bị ghi lặp thành 2 dòng.
    if(statusEl && !statusEl.classList.contains('err')){
      statusEl.className = 'upload-status';
      statusEl.textContent = detail
        ? `● Có thay đổi chưa lưu (${detail}) — bấm "Lưu" để đẩy lên Cloud.`
        : '● Có thay đổi chưa lưu — bấm "Lưu" để đẩy lên Cloud.';
    }
  }, 400);
}
function clearUnsavedChanges(){
  hasUnsavedChanges = false;
  _localInventoryDirty = false;
  _localShipDirty = false;
  _localContOverridesDirty = false;
  _localKhoGridDirty = false;
  const btn = document.getElementById('btn-save-cloud');
  if(btn) btn.classList.remove('has-changes');
}
// So sánh 2 chuỗi có THỰC SỰ khác nhau về NỘI DUNG hay không — nếu cả 2 đều là JSON hợp lệ, so sánh
// sau khi sắp lại thứ tự khoá object (đệ quy), bỏ qua khác biệt thuần tuý do THỨ TỰ CHÈN KHOÁ khác
// nhau (VD: 1 nơi dựng lại object theo thứ tự cố định, nơi khác theo đúng thứ tự đã lưu — nội dung y
// hệt nhưng JSON.stringify() ra chuỗi khác nhau). Đây chính là nguyên nhân bị báo nhầm "có thay đổi
// chưa lưu" mỗi lần mở lại trang dù chưa ai sửa gì — nặng hơn là còn chặn luôn cả Realtime (coi là
// "đang có thay đổi chưa lưu" nên không bao giờ dám tự áp dụng dữ liệu mới từ thiết bị khác).
// KHÔNG đổi thứ tự phần tử trong mảng (thứ tự đó có ý nghĩa thật), chỉ sắp lại khoá của OBJECT.
function tn5StableStringify(value){
  if(Array.isArray(value)) return '[' + value.map(tn5StableStringify).join(',') + ']';
  if(value && typeof value === 'object'){
    return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + tn5StableStringify(value[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}
function tn5ValuesEqual(oldStr, newStr){
  if(oldStr === newStr) return true;
  if(oldStr === null || oldStr === undefined) return false;
  try{
    return tn5StableStringify(JSON.parse(oldStr)) === tn5StableStringify(JSON.parse(newStr));
  }catch(e){ return false; } // không phải JSON (VD chuỗi thường như tn5_theme='dark') -> đã so sánh === ở trên rồi, tới đây là THỰC SỰ khác
}

const LS = {
  getItem(k){ return Object.prototype.hasOwnProperty.call(_mem, k) ? _mem[k] : null; },
  // KHÔNG còn tự động đẩy lên Cloud/file mỗi khi có thay đổi — dữ liệu chỉ thực sự được ghi lên
  // Cloud khi người dùng bấm nút "Lưu" (xem btn-save-cloud). Lý do: cơ chế tự động ghi có debounce
  // trước đây từng làm mất dữ liệu nếu người dùng đóng tab ngay sau khi thao tác, hoặc bị ghi đè
  // ngoài ý muốn giữa nhiều tab/thiết bị. Ở đây chỉ đánh dấu "có thay đổi chưa lưu".
  // Riêng bản sao lưu cục bộ (localStorage thật) thì ghi NGAY, không đợi bấm "Lưu" — đây chỉ là dự
  // phòng cho MÁY NÀY, không phải đồng bộ Cloud, nên không có rủi ro ghi đè máy khác.
  setItem(k, v){
    const strV = String(v);
    // BỎ QUA nếu giá trị Y HỆT đang có — nhiều nơi (VD: saveStateToStorage() chạy lại mỗi lần vẽ
    // dashboard) gọi setItem() cho gần như MỌI key dù nội dung chưa đổi gì, trước đây cứ gọi là báo
    // "có thay đổi chưa lưu" (kể cả không đổi) -> chuông thông báo bị spam gần hết danh sách mỗi lần
    // mở/tải lại trang. Chỉ thực sự ghi + báo khi nội dung khác trước.
    if(tn5ValuesEqual(_mem[k], strV)) return;
    _mem[k] = strV;
    try{ localStorage.setItem(TN5_LOCAL_BACKUP_PREFIX + k, strV); }catch(e){}
    scIdbSetKey(k, strV); // bản sao lưu IndexedDB — bổ sung, không giới hạn nhỏ như localStorage
    markUnsavedChanges(k);
  },
  removeItem(k){
    if(!(k in _mem)) return; // đã không có sẵn -> không có gì để xoá/báo thay đổi
    delete _mem[k];
    try{ localStorage.removeItem(TN5_LOCAL_BACKUP_PREFIX + k); }catch(e){}
    scIdbDeleteKey(k);
    markUnsavedChanges(k);
  }
};

const FileVault = {
  handle: null,
  supported: (typeof window !== 'undefined' && !!window.showSaveFilePicker && !!window.showOpenFilePicker),
  reloaders: [],
  _writeTimer: null,
  _ready: false,

  registerReloader(fn){ this.reloaders.push(fn); },

  _runReloaders(){
    this.reloaders.forEach(fn => { try{ fn(); }catch(e){ console.warn('FileVault reloader lỗi:', e); } });
  },

  async init(){
    this._bindUi();
    if(!this.supported){
      this._setStatus('Trình duyệt này không hỗ trợ tự đồng bộ file (chỉ Chrome/Edge/Opera) — dùng "Xuất JSON" / "Nhập JSON" bên dưới để lưu & khôi phục trạng thái.', 'err');
      return;
    }
    try{
      const saved = await fvIdbGet(FV_HANDLE_KEY);
      if(saved){
        this.handle = saved;
        const perm = await saved.queryPermission({ mode: 'readwrite' });
        if(perm === 'granted'){
          const ok = await this.readAll();
          this._setStatus(ok ? ('✓ Đã đồng bộ với file "' + saved.name + '".') : ('Đã kết nối file "' + saved.name + '" (file trống, sẽ ghi trạng thái hiện tại vào đó).'), 'ok');
          if(!ok) await this.writeAll();
        } else {
          this._setStatus('Cần cấp lại quyền cho file đồng bộ "' + saved.name + '" — bấm "Kết nối lại".', 'err');
        }
      } else {
        // File trên máy chỉ là PHƯƠNG ÁN DỰ PHÒNG khi đã có Cloud (xem đầu module) — nếu Cloud đã
        // được cấu hình rồi thì "chưa chọn file đồng bộ" không phải vấn đề gì cả, không cần báo (mỗi
        // lần mở app đều thấy dòng này dù chẳng phải làm gì — gây spam thông báo). Chỉ thực sự nhắc
        // khi CHƯA có Cloud để dự phòng — lúc đó file trên máy là chỗ lưu duy nhất, mới đáng chú ý.
        let cloudConfigured = false;
        try{ cloudConfigured = !!(localStorage.getItem(CV_LS_URL) && localStorage.getItem(CV_LS_TOKEN)); }catch(e){}
        if(!cloudConfigured){
          this._setStatus('Chưa chọn file đồng bộ — bấm "Chọn file đồng bộ" để bắt đầu tự lưu trạng thái vào 1 file trên máy.', '');
        }
      }
    }catch(e){ console.warn('FileVault init lỗi:', e); }
  },

  async chooseFile(){
    if(!this.supported){ alert('Trình duyệt này không hỗ trợ chọn file để tự đồng bộ. Hãy dùng "Xuất JSON" / "Nhập JSON".'); return; }
    try{
      // Dùng showOpenFilePicker (không phải showSaveFilePicker) để ĐẢM BẢO đọc được
      // đúng nội dung hiện có trong file đã chọn — showSaveFilePicker không đảm bảo
      // trả về nội dung cũ khi chọn 1 file đã tồn tại.
      const [handle] = await window.showOpenFilePicker({
        multiple: false,
        types: [{ description: 'JSON', accept: { 'application/json': ['.json'] } }]
      });
      const perm = await handle.requestPermission({ mode: 'readwrite' });
      if(perm !== 'granted'){
        this._setStatus('✗ Không được cấp quyền ghi vào file đã chọn.', 'err');
        return;
      }
      this.handle = handle;
      await fvIdbSet(FV_HANDLE_KEY, handle);
      const ok = await this.readAll();
      if(ok){
        this._setStatus('✓ Đã nạp dữ liệu có sẵn từ file "' + handle.name + '" và bắt đầu tự đồng bộ.', 'ok');
      } else {
        await this.writeAll();
        this._setStatus('✓ Đã kết nối file "' + handle.name + '" (file trống, đã ghi trạng thái hiện tại vào đó).', 'ok');
      }
    }catch(e){
      if(e && e.name === 'AbortError') return;
      console.warn('Chọn file lỗi:', e);
      this._setStatus('✗ Không chọn được file: ' + e.message, 'err');
    }
  },

  async createNewFile(){
    if(!this.supported){ alert('Trình duyệt này không hỗ trợ tạo file để tự đồng bộ. Hãy dùng "Xuất JSON".'); return; }
    try{
      const handle = await window.showSaveFilePicker({
        suggestedName: 'tn5-dashboard-state.json',
        types: [{ description: 'JSON', accept: { 'application/json': ['.json'] } }]
      });
      this.handle = handle;
      await fvIdbSet(FV_HANDLE_KEY, handle);
      await this.writeAll();
      this._setStatus('✓ Đã tạo file đồng bộ mới: ' + handle.name, 'ok');
    }catch(e){
      if(e && e.name === 'AbortError') return;
      console.warn('Tạo file lỗi:', e);
      this._setStatus('✗ Không tạo được file: ' + e.message, 'err');
    }
  },

  async reconnect(){
    if(!this.handle) return this.chooseFile();
    try{
      const perm = await this.handle.requestPermission({ mode: 'readwrite' });
      if(perm === 'granted'){
        await this.readAll();
        this._setStatus('✓ Đã kết nối lại file "' + this.handle.name + '".', 'ok');
      } else {
        this._setStatus('✗ Quyền truy cập file bị từ chối.', 'err');
      }
    }catch(e){ this._setStatus('✗ Lỗi kết nối lại: ' + e.message, 'err'); }
  },

  async readAll(){
    if(!this.handle) return false;
    try{
      const file = await this.handle.getFile();
      const text = await file.text();
      if(!text || !text.trim()) return false;
      const parsed = JSON.parse(text);
      if(!parsed || typeof parsed.data !== 'object' || !parsed.data) return false;
      Object.keys(_mem).forEach(k => delete _mem[k]);
      Object.assign(_mem, parsed.data);
      this._runReloaders();
      if(typeof clearUnsavedChanges === 'function') clearUnsavedChanges();
      return true;
    }catch(e){ console.warn('Đọc file đồng bộ lỗi:', e); return false; }
  },

  scheduleWrite(){
    if(!this.handle) return;
    clearTimeout(this._writeTimer);
    this._writeTimer = setTimeout(() => { this.writeAll(); }, 400);
  },

  async writeAll(){
    if(!this.handle) return;
    try{
      const writable = await this.handle.createWritable();
      await writable.write(JSON.stringify({ savedAt: new Date().toISOString(), data: _mem }));
      await writable.close();
    }catch(e){ console.warn('Ghi file đồng bộ lỗi:', e); this._setStatus('✗ Không ghi được file đồng bộ: ' + e.message, 'err'); }
  },

  exportJson(){
    const blob = new Blob([JSON.stringify({ savedAt: new Date().toISOString(), data: _mem }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const p = n => String(n).padStart(2,'0');
    const d = new Date();
    a.href = url;
    a.download = `tn5-dashboard-state-${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.json`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    this._setStatus('✓ Đã xuất file JSON trạng thái.', 'ok');
  },

  async importJsonFile(file){
    try{
      const text = await file.text();
      const parsed = JSON.parse(text);
      if(!parsed || typeof parsed.data !== 'object' || !parsed.data) throw new Error('File không đúng định dạng trạng thái của dashboard.');
      const ok = confirm('Nhập trạng thái từ file "' + file.name + '" sẽ GHI ĐÈ toàn bộ dữ liệu hiện tại (tồn kho, Plan, đã xác nhận, Transaction, So sánh...). Tiếp tục?');
      if(!ok) return;
      Object.keys(_mem).forEach(k => delete _mem[k]);
      Object.assign(_mem, parsed.data);
      this._runReloaders();
      // Đẩy dữ liệu vừa nhập lên đúng nơi đang đồng bộ — ưu tiên Cloud nếu đã kết nối,
      // nếu không thì mới ghi vào file trên máy (trước đây chỉ ghi file, quên đẩy Cloud).
      if(typeof CloudVault !== 'undefined' && CloudVault.url && CloudVault.token) await CloudVault.writeAll();
      else if(this.handle) await this.writeAll();
      this._setStatus('✓ Đã nhập trạng thái từ file "' + file.name + '".', 'ok');
    }catch(e){ this._setStatus('✗ Lỗi nhập file: ' + e.message, 'err'); }
  },

  _bindUi(){
    const chooseBtn = document.getElementById('fv-choose-btn');
    const createBtn = document.getElementById('fv-create-btn');
    const reconnectBtn = document.getElementById('fv-reconnect-btn');
    const exportBtn = document.getElementById('btn-export-state');
    const importBtn = document.getElementById('btn-import-state');
    const importInput = document.getElementById('import-state-input');
    if(chooseBtn) chooseBtn.addEventListener('click', () => this.chooseFile());
    if(createBtn) createBtn.addEventListener('click', () => this.createNewFile());
    if(reconnectBtn) reconnectBtn.addEventListener('click', () => this.reconnect());
    if(exportBtn) exportBtn.addEventListener('click', () => this.exportJson());
    if(importBtn && importInput) importBtn.addEventListener('click', () => importInput.click());
    if(importInput) importInput.addEventListener('change', (e) => {
      const f = e.target.files[0];
      if(f) this.importJsonFile(f);
      importInput.value = '';
    });
  },

  _setStatus(msg, kind){
    const el = document.getElementById('fv-status');
    if(el){ el.textContent = msg; el.className = 'upload-status' + (kind === 'ok' ? ' ok' : kind === 'err' ? ' err' : ''); }
  }
};

/* ============================================================
   ============  CloudVault: lưu trạng thái LÊN INTERNET (Firebase Realtime Database)  ============
   ============  Hoạt động trên MỌI trình duyệt, kể cả Safari/iPhone  ============
   ============================================================
   - Dùng Firebase Realtime Database (free tier — 1GB lưu trữ, 10GB băng thông/tháng) làm nơi lưu
     trạng thái, thay cho Google Apps Script (hay bị "cold start" tải chậm vài giây mỗi lần gọi).
   - "Database URL" + "Database secret": dán URL Realtime Database (dạng
     https://ten-du-an-default-rtdb.<region>.firebasedatabase.app/) và Database secret (lấy ở
     Project settings → Service accounts → Database secrets, mục Legacy).
   - "Kết nối": tải dữ liệu hiện có từ node "dashboard_data" của Database đó lên; nếu chưa có dữ
     liệu, lần ghi đầu tiên sẽ tự tạo.
   - Database URL & secret là THÔNG TIN KẾT NỐI (không phải dữ liệu dashboard) nên vẫn lưu trong
     localStorage của trình duyệt để khỏi phải nhập lại; dữ liệu THẬT của dashboard nằm trên
     Firebase, không nằm trong localStorage.
   - "Web API Key" (tuỳ chọn — để trống vẫn dùng bình thường, chỉ mất khả năng realtime): bật thêm
     lớp ĐỒNG BỘ REALTIME THẬT (WebSocket qua Firebase SDK, đăng nhập ẩn danh) — thiết bị khác vừa
     ghi thay đổi lên Cloud sẽ TỰ ĐỘNG kéo về máy này ngay, không cần bấm "Làm mới dữ liệu" nữa. Có
     bảo vệ: KHÔNG BAO GIỜ tự ghi đè trong lúc người dùng đang gõ dở/chưa lưu — sẽ tự áp dụng ngay
     khi an toàn (xem _isSafeToApply/_pendingStampDirty). Cần bật "Anonymous" trong Firebase
     Authentication → Sign-in method trước khi dùng được. */
const CV_LS_URL = 'tn5_cloud_gas_url';
const CV_LS_TOKEN = 'tn5_cloud_gas_token';
const CV_LS_APIKEY = 'tn5_cloud_apikey';

const CloudVault = {
  url: '',
  token: '',
  apiKey: '',
  _writeTimer: null,
  _retryTimer: null,
  _retryCount: 0,
  _hadError: false,
  _gotInitialData: false, // đã áp dụng được ít nhất 1 bản dữ liệu Cloud (qua REST hoặc realtime) chưa
  _lastReadBytes: 0, // dung lượng (byte) bản Cloud vừa tải/nhận gần nhất — hiện kèm trong thông báo
  _lastWriteBytes: 0, // dung lượng (byte) gói vừa GHI lên Cloud gần nhất — hiện kèm trong thông báo
  // --- Realtime (WebSocket, qua Firebase SDK) — lớp BỔ SUNG bên trên REST đã có sẵn ở trên. REST
  // vẫn là "xương sống" cho đọc/ghi chủ động (bấm Lưu, Kết nối, Kiểm tra...) vì đã có sẵn cơ chế
  // kiểm chứng & retry chắc chắn. Realtime CHỈ để tự phát hiện khi CÓ THIẾT BỊ KHÁC vừa ghi thay đổi
  // lên Cloud, rồi tự kéo về máy này ngay — không cần đợi người dùng bấm "Làm mới dữ liệu" nữa.
  _fbRef: null,
  _realtimeActive: false,
  _pendingStampDirty: false, // TRUE = mốc realtime vừa báo có gì mới trên Cloud nhưng máy này đang
  // gõ dở/chưa lưu nên chưa tải, sẽ tự tải đủ (qua REST) ngay khi an toàn — xem _flushPendingSnapshot.
  _safeCheckTimer: null,

  // Đường dẫn REST cố định trong Realtime Database — gộp mọi dữ liệu dashboard vào 1 node riêng
  // "dashboard_data", tránh đụng nếu sau này project Firebase này còn dùng cho việc khác.
  _dataUrl(){
    return this.url.replace(/\/+$/, '') + '/dashboard_data.json';
  },

  // Tham số chống cache cho các request ĐỌC (GET) — nối thêm 1 mốc luôn-khác-nhau vào URL và ép
  // fetch() bỏ qua HTTP cache (cache: 'no-store'). LÝ DO: readAll()/peek()/_checkCloudStamp() trước
  // đây luôn gọi ĐÚNG 1 URL y hệt nhau (chỉ khác token cố định) — nếu trình duyệt (hoặc 1 proxy/CDN
  // trung gian nào đó trên đường mạng) lỡ cache lại 1 phản hồi GET, các lần gọi sau CÓ THỂ nhận nhầm
  // bản CŨ đã cache thay vì dữ liệu thật mới nhất trên Cloud — dù Cloud đã ghi đúng dữ liệu mới. Đây
  // là nghi vấn gốc của bug "bấm Lưu xong vài giây sau dữ liệu lại hiện lại" dù chỉ dùng đúng 1 máy
  // (đã loại trừ được nguyên nhân do timer tự lưu/máy khác mở cùng lúc ở các lần sửa trước).
  _noCacheParam(){
    return '&_ts=' + Date.now() + '_' + Math.random().toString(36).slice(2);
  },

  init(){
    try{
      this.url = localStorage.getItem(CV_LS_URL) || '';
      this.token = localStorage.getItem(CV_LS_TOKEN) || '';
      this.apiKey = localStorage.getItem(CV_LS_APIKEY) || '';
    }catch(e){}
    this._bindUi();
    const urlInput = document.getElementById('cv-url-input');
    const tokenInput = document.getElementById('cv-token-input');
    const apiKeyInput = document.getElementById('cv-apikey-input');
    if(urlInput) urlInput.value = this.url;
    if(tokenInput) tokenInput.value = this.token;
    if(apiKeyInput) apiKeyInput.value = this.apiKey;
    if(this.url && this.token){
      this._pushedLocalToEmptyCloud = false;
      this._gotInitialData = false;
      if(this.apiKey){
        // CÓ Web API Key -> dùng THẲNG realtime (WebSocket) làm nguồn tải dữ liệu ban đầu, KHÔNG gọi
        // thêm readAll() REST song song nữa — trước đây làm cả 2, tải trùng nguyên khối dữ liệu 2 lần
        // ngay lúc mở trang (1 lần qua REST, 1 lần realtime tự tải khi vừa kết nối), tốn gấp đôi băng
        // thông. _startRealtime() tự có phương án dự phòng gọi lại REST nếu realtime lỗi (xem bên dưới).
        this._setStatus('Đang bật đồng bộ realtime…', '');
        try{ this._startRealtime(); }catch(e){
          console.warn('CloudVault: lỗi khởi động realtime:', e);
          this._smartReadAll();
        }
      } else {
        // KHÔNG có Web API Key -> chỉ còn REST. Trước khi tải TOÀN BỘ dữ liệu (có thể tới hàng MB),
        // kiểm tra 1 mốc nhỏ (_meta_updatedAt, chỉ vài chục byte) xem Cloud có gì mới hơn bản đang
        // cache cục bộ hay không — nếu không, dùng luôn cache, khỏi tải lại (tiết kiệm băng thông cho
        // phần lớn các lần mở app khi chưa ai sửa gì kể từ lần trước).
        this._setStatus('Đang kiểm tra dữ liệu Cloud…', '');
        this._smartReadAll();
      }
    } else {
      this._setStatus('Chưa kết nối Cloud — dán Database URL + Database secret rồi bấm "Kết nối".', '');
    }
  },

  saveCreds(){
    try{
      localStorage.setItem(CV_LS_URL, this.url);
      localStorage.setItem(CV_LS_TOKEN, this.token);
      localStorage.setItem(CV_LS_APIKEY, this.apiKey);
    }catch(e){}
  },

  async connect(){
    const urlInput = document.getElementById('cv-url-input');
    const tokenInput = document.getElementById('cv-token-input');
    const apiKeyInput = document.getElementById('cv-apikey-input');
    const url = urlInput ? urlInput.value.trim() : '';
    const token = tokenInput ? tokenInput.value.trim() : '';
    const apiKey = apiKeyInput ? apiKeyInput.value.trim() : '';
    if(!url || !token){ this._setStatus('✗ Cần nhập cả Database URL và Database secret.', 'err'); return; }
    this.url = url;
    this.token = token;
    this.apiKey = apiKey;
    this._setStatus('Đang kết nối & tải dữ liệu từ Cloud…', '');
    this._pushedLocalToEmptyCloud = false;
    const ok = await this.readAll();
    if(ok){
      this.saveCreds();
      this._setStatus(
        this._pushedLocalToEmptyCloud
          ? `✓ Cloud đang trống — đã tải dữ liệu hiện có trên máy này LÊN Cloud (${fmtBytes(this._lastWriteBytes)}, không xoá mất dữ liệu cục bộ).`
          : `✓ Đã kết nối & tải dữ liệu từ Cloud (${fmtBytes(this._lastReadBytes)}).`,
        'ok'
      );
      try{ this._startRealtime(); }catch(e){ console.warn('CloudVault: lỗi khởi động realtime:', e); }
    } else {
      this._setStatus('✗ Không tải được — kiểm tra lại Database URL / Database secret, hoặc bấm "Kiểm tra kết nối" để xem lỗi chi tiết. (Kiểm tra lại đã dán đúng Database secret ở mục Project settings → Service accounts, và Rules đã Publish chưa.)', 'err');
    }
  },

  disconnect(){
    this._stopRealtime();
    this.url = '';
    this.token = '';
    this.apiKey = '';
    try{
      localStorage.removeItem(CV_LS_URL);
      localStorage.removeItem(CV_LS_TOKEN);
      localStorage.removeItem(CV_LS_APIKEY);
    }catch(e){}
    const urlInput = document.getElementById('cv-url-input');
    const tokenInput = document.getElementById('cv-token-input');
    const apiKeyInput = document.getElementById('cv-apikey-input');
    if(urlInput) urlInput.value = '';
    if(tokenInput) tokenInput.value = '';
    if(apiKeyInput) apiKeyInput.value = '';
    this._setStatus('Đã ngắt kết nối Cloud trên trình duyệt này.', '');
  },

  async testConnection(){
    const urlInput = document.getElementById('cv-url-input');
    const tokenInput = document.getElementById('cv-token-input');
    const url = (urlInput ? urlInput.value.trim() : '') || this.url;
    const token = (tokenInput ? tokenInput.value.trim() : '') || this.token;
    if(!url || !token){ this._setStatus('✗ Cần nhập cả Database URL và Database secret trước khi kiểm tra.', 'err'); return; }
    this._setStatus('Đang kiểm tra kết nối tới Firebase…', '');
    try{
      const testUrl = url.replace(/\/+$/, '') + '/dashboard_data.json?auth=' + encodeURIComponent(token);
      const res = await fetch(testUrl);
      const text = await res.text();
      let json = null;
      try{ json = JSON.parse(text); }catch(e){}
      if(res.ok && !(json && json.error)){
        this._setStatus('✓ Kết nối OK — Firebase trả về dữ liệu hợp lệ. Database URL & Database secret đúng.', 'ok');
      } else if(json && json.error){
        this._setStatus('✗ Firebase báo lỗi: "' + json.error + '" — kiểm tra lại đã dán đúng Database secret (Project settings → Service accounts → Database secrets) và Rules đã Publish đúng như hướng dẫn chưa.', 'err');
      } else if(!res.ok){
        this._setStatus('✗ Máy chủ trả về mã lỗi ' + res.status + '. Kiểm tra lại Database URL (dạng https://ten-du-an-default-rtdb....firebasedatabase.app/).', 'err');
      } else {
        this._setStatus('✗ Phản hồi không đúng định dạng mong đợi — kiểm tra lại đã dán đúng Database URL chưa.', 'err');
      }
    }catch(e){
      this._setStatus('✗ Không kết nối được tới máy chủ (lỗi mạng thật sự: "' + e.message + '") — kiểm tra Internet, hoặc URL dán bị sai/thiếu.', 'err');
    }
  },

  async readAll(){
    if(!this.url || !this.token) return false;
    try{
      const res = await fetch(this._dataUrl() + '?auth=' + encodeURIComponent(this.token) + this._noCacheParam(), { cache: 'no-store' });
      if(!res.ok) return false;
      const json = await res.json();
      if(json && json.error) return false;
      // Firebase trả về "null" (không phải {}) khi node đang trống — coi như dữ liệu rỗng.
      const cloudData = (json && typeof json === 'object') ? json : {};
      return await this._applyCloudSnapshot(cloudData);
    }catch(e){ console.warn('CloudVault đọc lỗi:', e); return false; }
  },

  // Đọc RIÊNG mốc "_meta_updatedAt" trên Cloud (chỉ vài chục byte) — KHÔNG đụng gì tới _mem/trạng
  // thái cục bộ, chỉ để biết Cloud có mới hơn máy này đang cache hay không mà không cần tải nguyên
  // khối dữ liệu lớn. Trả về null nếu không đọc được (mạng lỗi, node chưa từng có mốc này...) — khi
  // đó _smartReadAll() coi như "chưa rõ" và tải đủ như bình thường, để an toàn không bỏ sót dữ liệu mới.
  async _checkCloudStamp(){
    try{
      const url = this.url.replace(/\/+$/, '') + '/dashboard_data/' + STORAGE_KEY_META_STAMP + '.json';
      const res = await fetch(url + '?auth=' + encodeURIComponent(this.token) + this._noCacheParam(), { cache: 'no-store' });
      if(!res.ok) return null;
      const text = await res.text();
      this._lastReadBytes = new Blob([text]).size; // chỉ vài chục byte — hiện kèm trong thông báo "dữ liệu chưa đổi"
      const stamp = JSON.parse(text);
      return (stamp === null || stamp === undefined) ? null : String(stamp);
    }catch(e){ return null; }
  },

  // Tải "thông minh": chỉ tải nguyên khối dữ liệu (readAll — có thể tới hàng MB) khi mốc trên Cloud
  // THỰC SỰ khác mốc máy này đang cache cục bộ (đã cập nhật ở lần đồng bộ/ghi gần nhất) — nếu giống
  // hệt, nghĩa là chưa ai (kể cả máy này) sửa gì kể từ lần đồng bộ trước, dùng thẳng cache là đủ,
  // khỏi tải lại — đây chính là phần tiết kiệm băng thông Firebase nhiều nhất, vì phần lớn các lần mở
  // app không ai vừa sửa gì cả. Chỉ dùng cho đường REST-only (không có Web API Key/realtime) — xem init().
  async _smartReadAll(){
    const localStamp = _mem[STORAGE_KEY_META_STAMP] || '';
    const hasLocalData = Object.keys(_mem).some(k => k !== STORAGE_KEY_META_STAMP);
    if(hasLocalData && localStamp){
      const cloudStamp = await this._checkCloudStamp();
      if(cloudStamp && cloudStamp === localStamp){
        this._gotInitialData = true;
        if(typeof clearUnsavedChanges === 'function') clearUnsavedChanges();
        this._setStatus(`✓ Đã đồng bộ với Cloud (dữ liệu chưa đổi kể từ lần trước — dùng cache cục bộ, chỉ kiểm tra ${fmtBytes(this._lastReadBytes)} thay vì tải lại).`, 'ok');
        return true;
      }
    }
    const ok = await this.readAll();
    const msg = ok
      ? (this._pushedLocalToEmptyCloud
          ? `✓ Cloud đang trống — đã tải dữ liệu hiện có trên máy này LÊN Cloud (${fmtBytes(this._lastWriteBytes)}, không xoá mất dữ liệu cục bộ).`
          : `✓ Đã đồng bộ với Cloud (Firebase, đã tải ${fmtBytes(this._lastReadBytes)}).`)
      : '✗ Không tải được — kiểm tra lại Database URL / Database secret, hoặc bấm "Kiểm tra kết nối" để xem lỗi chi tiết.';
    this._setStatus(msg, ok ? 'ok' : 'err');
    return ok;
  },

  // Áp dụng 1 bản dữ liệu Cloud (từ readAll() HOẶC từ listener realtime) vào _mem + render lại toàn
  // bộ trang — TÁCH RIÊNG ra khỏi readAll() để realtime dùng lại đúng 1 logic gộp duy nhất, không
  // viết 2 nơi dễ lệch nhau.
  async _applyCloudSnapshot(cloudData){
    this._gotInitialData = true; // đã có ít nhất 1 bản dữ liệu Cloud thật sự áp dụng — dùng cho phương án dự phòng của realtime, xem _startRealtime()
    // Dung lượng bản Cloud vừa nhận (qua REST hay realtime đều tính chung ở đây) — để các thông báo
    // tải/đồng bộ hiện kèm số KB thực tế, giúp tự theo dõi băng thông đang dùng mà không cần vào
    // Firebase Console. Dùng Blob để tính đúng byte UTF-8 (tiếng Việt có dấu chiếm nhiều hơn 1 byte/ký tự).
    try{ this._lastReadBytes = new Blob([JSON.stringify(cloudData)]).size; }catch(e){ this._lastReadBytes = 0; }
    const cloudStamp = cloudData[STORAGE_KEY_META_STAMP] == null ? '' : String(cloudData[STORAGE_KEY_META_STAMP]);
    const localStampBeforeApply = _mem[STORAGE_KEY_META_STAMP] == null ? '' : String(_mem[STORAGE_KEY_META_STAMP]);
    // Không bao giờ áp dụng snapshot Cloud CŨ hơn cache hiện tại. Đặc biệt quan trọng sau thao tác
    // reset: một phản hồi/sự kiện cũ đến trễ không được phép phục hồi các dòng đã xoá.
    if(cloudStamp && localStampBeforeApply && /^\d+$/.test(cloudStamp) && /^\d+$/.test(localStampBeforeApply) && Number(cloudStamp) < Number(localStampBeforeApply)){
      return true;
    }
    const cloudIsEmpty = Object.keys(cloudData).length === 0;
    // Bỏ qua mốc _meta_updatedAt khi xét "máy này có dữ liệu thật hay không" — mốc này có thể còn
    // sót lại (VD: sau khi bấm "Xoá dữ liệu" chỉ xoá các mục thật, không xoá riêng mốc) dù không còn
    // dữ liệu thật nào, tránh đẩy nhầm 1 gói gần như rỗng (chỉ có mốc) lên Cloud.
    const localHasData = Object.keys(_mem).some(k => k !== STORAGE_KEY_META_STAMP);
    if(cloudIsEmpty && localHasData){
      // Cloud đang TRỐNG (vd: mới tạo Database lần đầu, hoặc dữ liệu trên Cloud bị mất) nhưng
      // máy này đang có dữ liệu — đẩy dữ liệu hiện có trên máy LÊN Cloud thay vì xoá mất dữ liệu cục bộ
      // bằng cách ghi đè với dữ liệu rỗng từ Cloud.
      this._pushedLocalToEmptyCloud = true;
      try{ await this.writeAll(); }catch(e){ /* đã báo lỗi trong writeAll, không làm hỏng luồng đọc */ }
      if(typeof clearUnsavedChanges === 'function') clearUnsavedChanges();
      return true;
    }

    // Cloud ĐÃ CÓ dữ liệu thật -> Cloud là NGUỒN XÁC THỰC DUY NHẤT, áp dụng NGUYÊN VẸN — không còn
    // giữ lại bất kỳ mục nào "chỉ-có-ở-máy-này" nữa (khác hẳn cách làm cũ, xem lý do dưới đây).
    //
    // LỊCH SỬ — TẠI SAO BỎ HẲN, không chỉ bỏ phần tự đẩy lên Cloud (đã bỏ ở v1.70) mà bỏ LUÔN cả phần
    // "giữ lại hiển thị": bug "dữ liệu đã xoá tự sống lại" tái diễn nhiều lần dù đã bỏ tự đẩy — máy A
    // xoá 1 danh sách (Đặt lại toàn bộ / bấm Lưu) và đồng bộ Cloud thành công; máy B đang mở sẵn,
    // KHÔNG bấm gì, vẫn đang giữ bản CŨ trong bộ nhớ (_mem) — khi máy B nhận snapshot mới từ Cloud
    // (do máy A vừa ghi, đã KHÔNG còn mục đó nữa), code cũ coi "mục nào Cloud thiếu so với _mem máy B"
    // là "dữ liệu mới của máy B chưa kịp lên Cloud", rồi giữ lại đưa NGƯỢC vào _mem để HIỂN THỊ — làm
    // đúng danh sách máy A vừa xoá lại hiện ra trên MÀN HÌNH máy B, dù không còn tự đẩy lên Cloud nữa.
    // Code không có cách nào phân biệt "dữ liệu mới máy này vừa làm, Cloud chưa kịp có" với "dữ liệu
    // Cloud đã bị XOÁ ở máy khác, máy này chỉ đơn giản CHƯA CẬP NHẬT" — 2 trường hợp nhìn y hệt nhau
    // (đều là "mục _mem có mà cloudData không có"), nên mọi cách "giữ lại" đều có rủi ro hồi sinh nhầm.
    //
    // An toàn vì: hàm này chỉ chạy tới đây khi _isSafeToApply() đã cho phép (xem _fetchFullSnapshotViaStamp)
    // — nghĩa là máy này KHÔNG có hasUnsavedChanges=true, nên không có dữ liệu mới thật sự đang dang dở
    // bị mất. Nếu máy này thật sự có dữ liệu mới, người dùng luôn phải tự bấm "Lưu" để đẩy lên (đúng
    // thiết kế app "dữ liệu chỉ thực sự ghi lên Cloud khi bấm Lưu") — lúc đó hasUnsavedChanges=true sẽ
    // tự chặn mọi snapshot Cloud ghi đè giữa chừng cho tới khi Lưu xong.
    Object.keys(_mem).forEach(k => delete _mem[k]);
    Object.assign(_mem, cloudData);
    tn5PersistMemToLocalBackup(); // cập nhật luôn bản sao lưu cục bộ theo đúng dữ liệu Cloud mới nhất

    if(typeof FileVault !== 'undefined') FileVault._runReloaders();

    if(typeof clearUnsavedChanges === 'function') clearUnsavedChanges();
    return true;
  },

  // ============ Realtime (WebSocket qua Firebase SDK) ============
  // An toàn: KHÔNG BAO GIỜ tự áp dụng dữ liệu mới trong lúc người dùng đang gõ dở (đang có ô nhập
  // liệu nào đó đang được focus) hoặc đang có thay đổi CHƯA LƯU trên máy này — tránh ghi đè mất số
  // liệu đang nhập ngay dưới tay người dùng. Nếu chưa an toàn, giữ lại cờ chờ (_pendingStampDirty) và
  // tự kiểm tra lại định kỳ, tải/áp dụng ngay khi an toàn.
  _isSafeToApply(){
    if(typeof hasUnsavedChanges !== 'undefined' && hasUnsavedChanges) return false;
    // Lớp bảo vệ thứ 2 (phòng khi hasUnsavedChanges lỡ bị xoá sớm ở đâu đó): còn BẤT KỲ hàng đợi tự
    // lưu Cloud nào (Plan, Xác nhận, Đề xuất kiểm...) chưa hoàn tất thì tuyệt đối chưa an toàn.
    if(typeof _pendingAutoSaveKeys !== 'undefined' && _pendingAutoSaveKeys.size > 0) return false;
    const ae = document.activeElement;
    if(!ae) return true;
    const tag = (ae.tagName || '').toLowerCase();
    if(tag === 'input' || tag === 'textarea' || tag === 'select') return false;
    if(ae.isContentEditable) return false;
    return true;
  },

  _setRealtimeStatus(msg, kind){
    const el = document.getElementById('cv-realtime-status');
    if(el){ el.textContent = msg; el.className = 'upload-status' + (kind === 'ok' ? ' ok' : kind === 'err' ? ' err' : ''); }
  },

  _startRealtime(){
    this._stopRealtime(); // huỷ kết nối realtime cũ (nếu có) trước khi mở kết nối mới
    if(!this.apiKey){
      this._setRealtimeStatus('ℹ Chưa nhập Web API Key — chỉ đồng bộ khi bấm nút (không tự động realtime). Xem hướng dẫn lấy Web API Key nếu muốn bật.', '');
      // Không có Web API Key -> không thể dùng realtime làm nguồn tải ban đầu, phải tải qua REST
      // (chỉ khi CHƯA có dữ liệu Cloud nào được áp dụng — tránh gọi lại REST thừa nếu init() hoặc
      // connect() đã tải xong trước khi gọi hàm này).
      if(!this._gotInitialData) this._smartReadAll();
      return;
    }
    if(typeof firebase === 'undefined'){
      this._setRealtimeStatus('⚠ Không tải được thư viện Firebase SDK (cần Internet) — không bật được realtime.', 'err');
      if(!this._gotInitialData) this._smartReadAll(); // dự phòng: vẫn tải được dữ liệu qua REST bình thường
      return;
    }
    try{
      if(!firebase.apps || !firebase.apps.length){
        firebase.initializeApp({ apiKey: this.apiKey, databaseURL: this.url });
      }
      this._setRealtimeStatus('Đang bật đồng bộ realtime…', '');
      firebase.auth().signInAnonymously()
        .then(() => {
          // CHỈ lắng nghe đúng 1 mốc nhỏ (_meta_updatedAt, vài chục byte) thay vì lắng nghe thẳng
          // TOÀN BỘ dữ liệu — xem _onRealtimeStampValue() để rõ lý do (Firebase SDK luôn tải nguyên
          // khối dữ liệu tại đường dẫn đang lắng nghe ngay khi vừa gắn listener, kể cả khi chẳng ai
          // sửa gì cả — nếu lắng nghe thẳng gốc, MỖI LẦN mở/tải lại trang sẽ luôn tốn lại hàng MB).
          this._fbRef = firebase.database().ref('dashboard_data/' + STORAGE_KEY_META_STAMP);
          this._fbRef.on('value', (snapshot) => this._onRealtimeStampValue(snapshot), (err) => {
            console.warn('CloudVault realtime lỗi:', err);
            this._setRealtimeStatus('⚠ Mất kết nối realtime: ' + err.message + ' — vẫn dùng được nút "Lưu"/"Làm mới dữ liệu" như bình thường.', 'err');
            if(!this._gotInitialData) this._smartReadAll(); // chưa kịp tải được lần nào -> dự phòng REST
          });
          // Lắng nghe RIÊNG khoá "_gate_config" (lịch ca/mở-tạm/khoá-thủ-công, xem khối chặn ca đầu
          // <body>) — để khi 1 thiết bị khác bấm "🔒 Khoá trang ngay"/đổi lịch ca, các thiết bị ĐANG
          // MỞ SẴN app (không chỉ thiết bị vừa tải trang) cũng bị đẩy ra màn hình khoá NGAY LẬP TỨC
          // qua kênh realtime — không phải đợi tự tải lại trang mới biết.
          this._gateRef = firebase.database().ref('dashboard_data/_gate_config');
          this._gateRef.on('value', (snapshot) => {
            const cfg = snapshot.val();
            if(!cfg || typeof gateApplyCloudConfig !== 'function') return;
            gateApplyCloudConfig(cfg);
            if(typeof gateEvalChoPhep === 'function' && !gateEvalChoPhep()) location.replace(typeof gateBustedUrl === 'function' ? gateBustedUrl('lock.html') : 'lock.html');
          });
          this._realtimeActive = true;
          this._setRealtimeStatus('✓ Đồng bộ realtime đang bật — thay đổi từ thiết bị khác sẽ tự cập nhật ngay.', 'ok');
          clearInterval(this._safeCheckTimer);
          this._safeCheckTimer = setInterval(() => this._flushPendingSnapshot(), 3000);
        })
        .catch(err => {
          this._setRealtimeStatus('⚠ Không đăng nhập ẩn danh được: ' + err.message + ' — kiểm tra đã bật "Anonymous" trong Firebase Authentication chưa, và Web API Key đã đúng chưa.', 'err');
          if(!this._gotInitialData) this._smartReadAll(); // dự phòng: không bật được realtime, vẫn tải được dữ liệu qua REST
        });
    }catch(e){
      this._setRealtimeStatus('⚠ Lỗi khởi tạo Firebase SDK: ' + e.message, 'err');
      if(!this._gotInitialData) this._smartReadAll(); // dự phòng
    }
  },

  _stopRealtime(){
    if(this._fbRef){ try{ this._fbRef.off(); }catch(e){} this._fbRef = null; }
    if(this._gateRef){ try{ this._gateRef.off(); }catch(e){} this._gateRef = null; }
    clearInterval(this._safeCheckTimer);
    this._safeCheckTimer = null;
    this._pendingStampDirty = false;
    this._realtimeActive = false;
    // Xoá app Firebase cũ (nếu có) để lần _startRealtime() sau luôn khởi tạo lại ĐÚNG url/apiKey mới
    // nhất — phòng trường hợp người dùng đổi Database URL/Web API Key rồi bấm "Kết nối" lại.
    if(typeof firebase !== 'undefined' && firebase.apps && firebase.apps.length){
      firebase.apps.forEach(app => { try{ app.delete(); }catch(e){} });
    }
    this._setRealtimeStatus('', '');
  },

  // Mốc "_meta_updatedAt" vừa được Cloud gửi về (do THIẾT BỊ KHÁC vừa ghi, do CHÍNH máy này vừa ghi,
  // HOẶC đơn giản là lần đầu gắn listener khi vừa mở trang — Firebase LUÔN gửi giá trị hiện tại ngay
  // khi vừa attach). Chỉ so sánh mốc (vài chục byte) với bản đang cache cục bộ TRƯỚC — GIỐNG HỆT nhau
  // thì coi như chưa ai sửa gì kể từ lần đồng bộ trước, KHÔNG tải lại nguyên khối dữ liệu; chỉ khi
  // mốc thực sự khác mới tải đủ 1 lần qua REST (_fetchFullSnapshotViaStamp) — đây chính là điểm tiết
  // kiệm băng thông: trước đây lắng nghe thẳng gốc dữ liệu nên MỖI LẦN mở/tải lại trang đều tải lại
  // toàn bộ (có thể tới vài MB) dù chẳng ai vừa sửa gì, giờ chỉ còn tốn vài chục byte cho phần lớn
  // các lần mở app.
  _onRealtimeStampValue(snapshot){
    const cloudStampRaw = snapshot.val();
    const cloudStamp = (cloudStampRaw === null || cloudStampRaw === undefined) ? '' : String(cloudStampRaw);
    const localStamp = _mem[STORAGE_KEY_META_STAMP] || '';
    // Bỏ qua tín hiệu realtime CŨ hơn bản đang có trên máy. Đây là lớp bảo vệ cuối cùng cho
    // trường hợp Firebase/realtime trả về một snapshot cũ ngay sau khi người dùng vừa bấm
    // "Đặt lại toàn bộ": nếu tải snapshot cũ lúc này, danh sách Đã xác nhận/Đề xuất kiểm
    // vừa xoá sẽ sống lại dù lần ghi reset đã thành công.
    if(cloudStamp && localStamp && /^\d+$/.test(cloudStamp) && /^\d+$/.test(String(localStamp)) && Number(cloudStamp) < Number(localStamp)){
      this._pendingStampDirty = false;
      return;
    }
    const hasLocalData = Object.keys(_mem).some(k => k !== STORAGE_KEY_META_STAMP);
    try{ this._lastReadBytes = new Blob([JSON.stringify(cloudStampRaw === undefined ? null : cloudStampRaw)]).size; }catch(e){ this._lastReadBytes = 0; }
    if(hasLocalData && cloudStamp && cloudStamp === localStamp){
      this._gotInitialData = true;
      this._pendingStampDirty = false;
      if(typeof clearUnsavedChanges === 'function') clearUnsavedChanges();
      this._setRealtimeStatus('✓ Đồng bộ realtime đang bật — thay đổi từ thiết bị khác sẽ tự cập nhật ngay.', 'ok');
      this._setStatus(`✓ Đã đồng bộ với Cloud (dữ liệu chưa đổi kể từ lần trước — dùng cache cục bộ, chỉ kiểm tra ${fmtBytes(this._lastReadBytes)} qua realtime).`, 'ok');
      return;
    }
    // Mốc khác bản cache (hoặc máy này chưa có dữ liệu nào) -> thực sự có gì đó mới, cần tải đủ 1 lần.
    this._fetchFullSnapshotViaStamp();
  },

  // Tải đủ 1 lần qua REST khi mốc realtime báo có gì mới — TÁI SỬ DỤNG readAll()/_applyCloudSnapshot()
  // (đúng 1 logic gộp duy nhất, không viết 2 nơi dễ lệch nhau).
  async _fetchFullSnapshotViaStamp(){
    if(!this._isSafeToApply()){
      // Đang gõ dở/chưa lưu -> KHÔNG tải/áp dụng ngay, chờ tới lúc an toàn (xem _flushPendingSnapshot).
      this._pendingStampDirty = true;
      this._setRealtimeStatus('🔄 Có dữ liệu mới từ thiết bị khác — sẽ tự áp dụng ngay khi bạn ngừng nhập/đã lưu xong.', '');
      return;
    }
    this._pendingStampDirty = false;
    // Lần ĐẦU TIÊN nhận được dữ liệu qua realtime (init() không còn tự gọi readAll() REST song song
    // nữa khi có Web API Key, xem init()) -> đây chính là lần tải dữ liệu ban đầu, cập nhật luôn
    // trạng thái chính (#cv-status) để không bị kẹt mãi ở "Đang bật đồng bộ realtime…".
    const isFirstLoad = !this._gotInitialData;
    const ok = await this.readAll();
    if(ok){
      this._setRealtimeStatus(`✓ Realtime đang bật — vừa tự cập nhật dữ liệu mới nhất (${fmtBytes(this._lastReadBytes)}).`, 'ok');
      if(isFirstLoad) this._setStatus(`✓ Đã đồng bộ với Cloud (Firebase, qua realtime — không tải REST trùng lặp, ${fmtBytes(this._lastReadBytes)}).`, 'ok');
    }
  },

  _flushPendingSnapshot(){
    if(!this._pendingStampDirty) return;
    if(!this._isSafeToApply()) return;
    this._fetchFullSnapshotViaStamp();
  },

  // Đọc dữ liệu THÔ hiện có trên Cloud, KHÔNG đụng gì tới _mem/trạng thái cục bộ — chỉ để "nhìn
  // trộm" bản mới nhất trên Cloud trước khi ghi, phục vụ gộp dữ liệu (xem mergeConfirmedDataFromCloud).
  async peek(){
    if(!this.url || !this.token) return null;
    try{
      const res = await fetch(this._dataUrl() + '?auth=' + encodeURIComponent(this.token) + this._noCacheParam(), { cache: 'no-store' });
      if(!res.ok) return null;
      const json = await res.json();
      if(json && json.error) return null;
      return (json && typeof json === 'object') ? json : {};
    }catch(e){ return null; }
  },

  scheduleWrite(){
    if(!this.url || !this.token) return;
    clearTimeout(this._writeTimer);
    clearTimeout(this._retryTimer);
    this._retryCount = 0;
    this._writeTimer = setTimeout(() => { this.writeAll().catch(() => {}); }, 1500);
  },

  // Xếp hàng các lượt ghi lên Cloud để KHÔNG BAO GIỜ chạy chồng chéo (VD: tải liền 3 Plan Row/
  // FC/HCP, mỗi lần tải tự gọi writeAll() riêng) — nếu 2 request cùng gửi song song, request cũ
  // (dữ liệu còn thiếu) có thể phản hồi VỀ SAU request mới hơn và ghi đè mất dữ liệu đầy đủ hơn.
  // Xếp hàng đảm bảo lượt sau luôn đợi lượt trước xong mới gửi, nên luôn lấy đúng _mem mới nhất.
  async writeAll(){
    const attempt = (this._writeChain || Promise.resolve()).then(() => this._writeAllNow());
    // QUAN TRỌNG: "chốt" hàng đợi (_writeChain) luôn ở trạng thái ĐÃ GIẢI QUYẾT (never rejected) —
    // nếu để nguyên `attempt` (có thể bị reject khi ghi lỗi) làm baton cho lượt sau, mọi lượt gọi
    // writeAll()/writeMerge() TIẾP THEO sẽ chain lên 1 promise ĐÃ REJECT, khiến .then() bị bỏ qua
    // luôn — _writeAllNow()/_writeMergeNow() KHÔNG BAO GIỜ được gọi lại thật, chỉ lặp lại y nguyên
    // lỗi CŨ mãi mãi (dù mạng đã khoẻ lại) cho tới khi tải lại trang (baton mới được tạo lại từ đầu).
    // Đây chính là nguyên nhân "Lưu lên Cloud thất bại: Failed to fetch" cứ lặp lại giống nhau dù đã
    // đổi sang wifi full sóng. Vẫn TRẢ VỀ đúng `attempt` (chứa lỗi thật) cho caller biết để báo đỏ.
    this._writeChain = attempt.catch(() => {});
    return attempt;
  },

  // Ghi 1 GÓI NHỎ, chỉ gồm đúng các key được chỉ định (VD: chỉ mỗi Plan) — dùng PATCH của Firebase,
  // tự động GHÉP (merge) các key gửi lên vào dữ liệu đang có trên Cloud thay vì ghi đè toàn bộ node.
  // Dùng cho những dữ liệu quan trọng nhưng nhỏ gọn (như Plan) để không bị "chết chung" với gói lớn
  // (tồn kho + lịch sử có thể lên tới hàng MB, dễ đứt giữa chừng trên mạng chậm) — cũng xếp hàng
  // chung 1 chuỗi với writeAll() để không bao giờ chạy chồng chéo nhau.
  async writeMerge(keys){
    const attempt = (this._writeChain || Promise.resolve()).then(() => this._writeMergeNow(keys));
    // Cùng lý do với writeAll() ở trên — baton hàng đợi không bao giờ được để ở trạng thái reject.
    this._writeChain = attempt.catch(() => {});
    return attempt;
  },

  async _writeMergeNow(keys){
    if(!this.url || !this.token) return;
    // QUAN TRỌNG: với key đã bị XÁC (không còn trong _mem, VD: vừa "Xoá danh sách" làm rỗng hẳn),
    // PHẢI gửi rõ giá trị null cho key đó — Firebase PATCH coi "null" là lệnh XOÁ đúng key đó trên
    // Cloud. Trước đây chỉ ĐƠN GIẢN BỎ QUA key không còn trong _mem (không gửi gì cho nó), khiến
    // Cloud KHÔNG BAO GIỜ biết là cần xoá — cứ giữ mãi bản dữ liệu CŨ, nên "Xoá danh sách" xong đợi
    // 1 lúc/tải lại trang sẽ luôn thấy nó "sống lại" y như cũ, dù xoá trên máy vẫn chạy đúng.
    const partial = {};
    keys.forEach(k => { partial[k] = (k in _mem) ? _mem[k] : null; });
    // Luôn kèm theo mốc đồng bộ mới nhất trong CHÍNH gói ghi này (không tốn thêm request riêng) — để
    // các máy REST-only (xem _smartReadAll) biết chính xác lần ghi gần nhất là khi nào, dù ghi bằng
    // writeMerge() (gói nhỏ) hay writeAll() (toàn bộ) đều cùng cập nhật đúng 1 mốc thống nhất.
    const newStamp = String(Date.now());
    partial[STORAGE_KEY_META_STAMP] = newStamp;
    const payload = JSON.stringify(partial);
    try{
      const res = await fetch(this._dataUrl() + '?auth=' + encodeURIComponent(this.token), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        cache: 'no-store'
      });
      const bodyJson = await res.json().catch(() => null);
      if(!res.ok) throw new Error('HTTP ' + res.status + (bodyJson && bodyJson.error ? ' — ' + bodyJson.error : ''));
      if(bodyJson && bodyJson.error) throw new Error(bodyJson.error);

      // Kiểm chứng NGAY TỪ PHẢN HỒI CỦA PATCH: Firebase trả lại đúng phần dữ liệu vừa ghép (kể cả
      // key vừa bị xoá, giá trị sẽ là null) trong response body của chính request này — không cần
      // gửi thêm request nào để "tải lại" mới biết.
      const bad = keys.filter(k => {
        if(partial[k] === null) return !bodyJson || bodyJson[k] !== null; // key vừa xoá -> phải thấy null
        return !bodyJson || !(k in bodyJson) || String(bodyJson[k]).length < String(partial[k]).length;
      });
      if(bad.length) throw new Error('Cloud không lưu đủ (thiếu/thiếu bớt: ' + bad.join(', ') + ')');
      tn5SetMetaStamp(newStamp); // ghi đúng mốc vừa gửi vào bản cache cục bộ, để lần mở app sau nhận ra đây LÀ bản mới nhất, khỏi tải lại
      // LỖI THẬT ĐÃ GẶP (VD: xác nhận xong kiểm tồn, bấm Lưu, tải lại trang thấy DANH SÁCH CŨ hiện lại
      // — dù bấm "Làm mới dữ liệu" thì đúng): tn5SetMetaStamp() ở trên CHỈ ghi mốc _meta_updatedAt vào
      // bản sao lưu cục bộ (localStorage/IndexedDB), KHÔNG ghi lại NỘI DUNG các key vừa đổi (VD:
      // ccKhoResults, confirmedKiemTonItems...) — bản sao lưu cục bộ bị "nửa mới nửa cũ": mốc thì mới,
      // nội dung thì cũ. Lần mở trang sau, tn5SeedMemFromLocalBackup() nạp đúng bản nửa-cũ này vào
      // _mem RỒI MỚI kiểm tra Cloud — mà lúc đó mốc cục bộ (đã là mốc MỚI) lại khớp y hệt mốc Cloud,
      // nên _smartReadAll()/realtime tưởng nhầm "chưa đổi gì", bỏ qua không tải lại, để nguyên nội
      // dung cũ hiển thị mãi — chỉ "Làm mới dữ liệu" (luôn tải lại KHÔNG so mốc) mới sửa được. Gọi
      // thêm tn5PersistMemToLocalBackup() ngay sau đây để đồng bộ luôn NỘI DUNG (không chỉ mốc) vào
      // bản sao lưu cục bộ, tránh tình trạng nửa mới nửa cũ này.
      tn5PersistMemToLocalBackup();
      this._lastWriteBytes = new Blob([payload]).size; // để caller hiện kèm dung lượng vừa gửi trong thông báo
      // QUAN TRỌNG: vừa đẩy thành công state MỚI NHẤT của máy này lên Cloud — mọi tín hiệu realtime
      // đang CHỜ tải lại (_pendingStampDirty, xem _onRealtimeStampValue) giờ đã CŨ hơn state vừa ghi,
      // tải lại vào lúc này sẽ VÔ TÌNH GHI ĐÈ MẤT thay đổi vừa lưu (VD: khôi phục 1 dòng đã xác nhận
      // xong bấm Lưu, 1 lúc sau tự động tải lại bản cũ làm dòng đó "hiện lại" trong Đã xác nhận). Huỷ
      // cờ chờ luôn — an toàn hơn là để nó tải nhầm dữ liệu cũ.
      this._pendingStampDirty = false;
      this._retryCount = 0;
      clearTimeout(this._retryTimer);
    }catch(e){
      console.warn('CloudVault ghi (merge) lỗi:', e);
      throw e;
    }
  },

  async _writeAllNow(){
    if(!this.url || !this.token) return;
    try{
      // Đưa mốc đồng bộ mới vào NGAY TRONG gói PUT này (không tốn thêm request riêng) — để các máy
      // REST-only (xem _smartReadAll) biết chính xác lần ghi gần nhất là khi nào.
      const newStamp = String(Date.now());
      _mem[STORAGE_KEY_META_STAMP] = newStamp;
      const payload = JSON.stringify(_mem);
      // PUT ghi đè TOÀN BỘ node "dashboard_data" trên Firebase bằng đúng _mem hiện tại.
      const res = await fetch(this._dataUrl() + '?auth=' + encodeURIComponent(this.token), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        cache: 'no-store'
      });
      const bodyJson = await res.json().catch(() => null);
      if(!res.ok) throw new Error('HTTP ' + res.status + (bodyJson && bodyJson.error ? ' — ' + bodyJson.error : ''));
      if(bodyJson && bodyJson.error) throw new Error(bodyJson.error);

      // KIỂM CHỨNG NGAY TỪ PHẢN HỒI CỦA PUT: Firebase trả lại ĐÚNG dữ liệu vừa ghi trong response
      // body của chính request PUT này — không cần gửi thêm 1 request GET riêng để "tải lại" mới biết
      // (trước đây làm vậy, tốn gấp đôi băng thông mỗi lần lưu — đây chính là lý do mục "Downloads"
      // trên Firebase Console tăng nhanh hơn nhiều so với dung lượng dữ liệu thực tế đang lưu).
      const cloudData = (bodyJson && typeof bodyJson === 'object') ? bodyJson : null;
      if(cloudData){
        const missing = Object.keys(_mem).filter(k => !(k in cloudData));
        const truncated = Object.keys(_mem).filter(k => (k in cloudData) && String(cloudData[k]).length < String(_mem[k]).length);
        if(missing.length || truncated.length){
          const sizeKB = Math.round(payload.length / 1024);
          throw new Error(
            `Cloud nhận nhưng KHÔNG lưu đủ dữ liệu (thiếu: ${missing.concat(truncated).join(', ') || 'không rõ'}). ` +
            `Dung lượng đang gửi ~${sizeKB} KB — kiểm tra lại Rules đã Publish đúng, và tài khoản Firebase chưa vượt hạn mức miễn phí. ` +
            `Hãy dùng "Xuất JSON" để sao lưu ngay nếu nghi ngờ mất dữ liệu.`
          );
        }
      }

      tn5SetMetaStamp(newStamp); // ghi đúng mốc vừa gửi vào bản cache cục bộ, để lần mở app sau nhận ra đây LÀ bản mới nhất, khỏi tải lại
      // Cùng lý do đã ghi chú kỹ ở _writeMergeNow() phía trên — tn5SetMetaStamp() chỉ cập nhật MỐC
      // trong bản sao lưu cục bộ, không cập nhật NỘI DUNG _mem, khiến bản sao lưu bị "nửa mới nửa cũ"
      // và qua mặt được bước so mốc ở lần mở trang sau. Gọi thêm để đồng bộ luôn nội dung.
      tn5PersistMemToLocalBackup();
      this._lastWriteBytes = new Blob([payload]).size; // để caller hiện kèm dung lượng vừa gửi trong thông báo
      this._retryCount = 0;
      clearTimeout(this._retryTimer);
      // QUAN TRỌNG: vừa đẩy thành công TOÀN BỘ state mới nhất của máy này lên Cloud — huỷ mọi
      // cờ chờ tải lại qua realtime (xem _writeMergeNow ở trên để rõ lý do) vì giờ nó đã cũ hơn.
      this._pendingStampDirty = false;
      if(this._hadError){ this._setStatus('✓ Đã đồng bộ lại lên Cloud.', 'ok'); this._hadError = false; }
    }catch(e){
      console.warn('CloudVault ghi lỗi:', e);
      this._hadError = true;
      const isNetworkErr = /Failed to fetch|NetworkError|Load failed/i.test(e.message || '');
      // Cloud lỗi/mất kết nối -> tạm chuyển sang lưu vào file trên máy (nếu đã chọn sẵn) để không mất
      // dữ liệu trong lúc chờ Cloud kết nối lại. LS.setItem sẽ tự ưu tiên Cloud trở lại ngay khi thành công.
      const fallbackActive = (typeof FileVault !== 'undefined' && !!FileVault.handle);
      if(fallbackActive) FileVault.scheduleWrite();
      const hint = isNetworkErr
        ? ' — có thể do mất mạng, hoặc trình duyệt/app đang mở file này không cho phép kết nối Internet.'
        : ': ' + e.message;
      const fallbackMsg = fallbackActive
        ? ' Đã tạm chuyển sang lưu vào file trên máy cho tới khi Cloud kết nối lại.'
        : ' Chưa có file đồng bộ trên máy để dự phòng — dữ liệu vẫn giữ tạm trong bộ nhớ, sẽ tự thử ghi lại lên Cloud.';
      this._setStatus('✗ Mất kết nối Cloud' + hint + fallbackMsg, 'err');
      this._retryCount = (this._retryCount || 0) + 1;
      if(this._retryCount <= 4){
        const delay = 3000 * Math.pow(3, this._retryCount - 1);
        clearTimeout(this._retryTimer);
        this._retryTimer = setTimeout(() => this.writeAll(), delay);
      }
      // Ném lỗi ra ngoài để nút "Lưu" / tự-lưu-Plan biết là THẤT BẠI và báo đỏ cho người dùng,
      // thay vì vẫn hiện "✓ Đã lưu lên Cloud" trong khi thực tế dữ liệu chưa lên (hoặc lên thiếu).
      throw e;
    }
  },

  _bindUi(){
    const connectBtn = document.getElementById('cv-connect-btn');
    const disconnectBtn = document.getElementById('cv-disconnect-btn');
    const testBtn = document.getElementById('cv-test-btn');
    if(connectBtn) connectBtn.addEventListener('click', () => this.connect());
    if(disconnectBtn) disconnectBtn.addEventListener('click', () => this.disconnect());
    if(testBtn) testBtn.addEventListener('click', () => this.testConnection());
  },

  _setStatus(msg, kind){
    const el = document.getElementById('cv-status');
    if(el){ el.textContent = msg; el.className = 'upload-status' + (kind === 'ok' ? ' ok' : kind === 'err' ? ' err' : ''); }
  }
};

/* ============ (các module bên dưới gọi LS.* giống hệt LS.* trước đây) ============ */
const STORAGE_KEY_INVENTORY = 'tn5_dashboard_inventory_v1';
const STORAGE_KEY_PLANS = 'tn5_dashboard_plans_v1';
const STORAGE_KEY_META = 'tn5_dashboard_meta_v1';
const STORAGE_KEY_CONFIRMED = 'tn5_dashboard_confirmed_v1';
const STORAGE_KEY_LASTCHECK = 'tn5_dashboard_lastcheck_v1';
const STORAGE_KEY_INVSNAPSHOT = 'tn5_dashboard_invsnapshot_v1';
const STORAGE_KEY_CCRESULTS = 'tn5_dashboard_ccresults_v1';
const STORAGE_KEY_KT_INPUTS = 'tn5_dashboard_kt_inputs_v1';
const STORAGE_OK = true;

function jsonReplacer(key, value){
  const orig = this[key];
  if(orig instanceof Date) return { __date: orig.toISOString() };
  return value;
}
function jsonReviver(key, value){
  if(value && typeof value === 'object' && value.__date) return new Date(value.__date);
  return value;
}

let confirmedKiemTonItems = {};

// Lịch sử "lần kiểm gần nhất" theo từng dòng Item No. + Locator — dùng để tính đề xuất
// Lịch kiểm hôm nay (mục 4 trong danh sách tính năng đề xuất). Key = item + '||' + locator.
let lastCheckedMap = {};

// Snapshot lịch sử tồn kho theo ngày — dùng để tính "SL tồn bất thường" trong Đề xuất kiểm hôm nay.
// Key = kho + '||' + item + '||' + locator -> [{ date:'YYYY-MM-DD', qty }, ...] sắp theo ngày tăng dần.
// Mỗi lần dữ liệu tồn kho được cập nhật (tải file mới / đồng bộ Cloud), tự động ghi/ghi đè snapshot của NGÀY HÔM ĐÓ.
let invSnapshotHistory = {};
const CC_SNAPSHOT_RETENTION_DAYS = 90; // chỉ giữ lịch sử trong 90 ngày gần nhất để dữ liệu lưu trữ không phình to

// Lưu tạm các giá trị người dùng đã gõ vào 6 ô "Kiểm thực tế" (KT =) theo từng dòng (key = rowKey),
// để khi bảng Kiểm tồn kho phải render lại (VD: sau khi bấm Xác nhận ở 1 dòng khác) thì các dòng
// còn lại KHÔNG bị reset số liệu đã nhập về 0.
let ktInputValues = {};

// Lấy rowKey (item|custpo|locator|oqc|qty) từ 1 <tr> của bảng Kiểm tồn kho / Tìm mã hàng,
// dùng chung cho cả việc lưu input tạm và xác nhận dòng. Đọc theo data-label thay vì vị trí cột cố
// định, để đổi thứ tự cột hiển thị ở bảng nào cũng không ảnh hưởng tới logic này.
function getRowKeyFromTr(tr){
  if(!tr) return '';
  const byLabel = (label) => {
    const cell = tr.querySelector(`td[data-label="${label}"]`);
    if(!cell) return '';
    const sel = cell.querySelector('select');
    if(sel) return sel.value;
    // Ưu tiên đọc trong .loc-text nếu có — tránh đọc lẫn chữ của các nút bấm khác cũng nằm
    // trong cùng ô (VD: nút "✓✓ Cả vị trí" nằm chung ô Locator).
    const textSpan = cell.querySelector('.loc-text');
    if(textSpan) return textSpan.textContent.trim();
    return cell.textContent.trim();
  };
  const item = byLabel('Item No.');
  const custpo = byLabel('Cust PO');
  const locator = byLabel('Locator');
  const oqcText = byLabel('OQC');
  const qtyText = byLabel('SL tồn');
  const qty = parseFloat(qtyText.replace(/,/g, '')) || 0;
  let oqc = 'Khac';
  if(oqcText.toUpperCase().includes('PASS')) oqc = 'PASS';
  else if(oqcText.toUpperCase().includes('NG')) oqc = 'NG';
  return item + '|' + custpo + '|' + locator + '|' + oqc + '|' + qty;
}


function saveStateToStorage(){
  if(!STORAGE_OK) return;
  try{
    if(currentData) LS.setItem(STORAGE_KEY_INVENTORY, JSON.stringify(currentData, jsonReplacer));
    else LS.removeItem(STORAGE_KEY_INVENTORY);

    const planSnapshot = {};
    PLAN_TYPES.forEach(t => { if(planData[t]) planSnapshot[t] = planData[t]; });
    if(Object.keys(planSnapshot).length) LS.setItem(STORAGE_KEY_PLANS, JSON.stringify(planSnapshot, jsonReplacer));
    else LS.removeItem(STORAGE_KEY_PLANS);

    LS.setItem(STORAGE_KEY_META, JSON.stringify({
      // KHÔNG lưu "savedAt" (thời điểm ghi) ở đây nữa — trường này đổi theo từng mili-giây, không
      // đọc lại ở đâu cả (chỉ tổ chiếm chỗ), nhưng lại khiến LS.setItem() LUÔN thấy "khác giá trị cũ"
      // dù nội dung thật sự không đổi gì, làm mất tác dụng của việc kiểm tra trùng giá trị (xem LS.setItem).
      inventoryFileName: currentFileName || null,
      updatedAtText: document.getElementById('updated-at-line') ? document.getElementById('updated-at-line').textContent : '',
    }));

    if(Object.keys(confirmedKiemTonItems).length) LS.setItem(STORAGE_KEY_CONFIRMED, JSON.stringify(confirmedKiemTonItems, jsonReplacer));
    else LS.removeItem(STORAGE_KEY_CONFIRMED);

    if(Object.keys(lastCheckedMap).length) LS.setItem(STORAGE_KEY_LASTCHECK, JSON.stringify(lastCheckedMap));
    else LS.removeItem(STORAGE_KEY_LASTCHECK);

    if(Object.keys(invSnapshotHistory).length) LS.setItem(STORAGE_KEY_INVSNAPSHOT, JSON.stringify(invSnapshotHistory));
    else LS.removeItem(STORAGE_KEY_INVSNAPSHOT);

    if(Object.keys(ccKhoResults).length) LS.setItem(STORAGE_KEY_CCRESULTS, JSON.stringify(ccKhoResults));
    else LS.removeItem(STORAGE_KEY_CCRESULTS);

    if(Object.keys(ktInputValues).length) LS.setItem(STORAGE_KEY_KT_INPUTS, JSON.stringify(ktInputValues));
    else LS.removeItem(STORAGE_KEY_KT_INPUTS);

    if(Object.keys(manualPickedContainers).length) LS.setItem(STORAGE_KEY_MANUAL_PICKED, JSON.stringify(manualPickedContainers));
    else LS.removeItem(STORAGE_KEY_MANUAL_PICKED);

    if(Object.keys(hiddenPlanContainers).length) LS.setItem(STORAGE_KEY_HIDDEN_CONT, JSON.stringify(hiddenPlanContainers));
    else LS.removeItem(STORAGE_KEY_HIDDEN_CONT);

    if(Object.keys(contPickComments).length) LS.setItem(STORAGE_KEY_CONT_COMMENTS, JSON.stringify(contPickComments));
    else LS.removeItem(STORAGE_KEY_CONT_COMMENTS);

    if(Object.keys(planContainerChangeInfo).length) LS.setItem(STORAGE_KEY_PLAN_CHANGE_INFO, JSON.stringify(planContainerChangeInfo));
    else LS.removeItem(STORAGE_KEY_PLAN_CHANGE_INFO);

    if(Object.keys(manualKhoOverrides).length) LS.setItem(STORAGE_KEY_MANUAL_KHO, JSON.stringify(manualKhoOverrides));
    else LS.removeItem(STORAGE_KEY_MANUAL_KHO);

    if(Object.keys(sppManualOk).length) LS.setItem(STORAGE_KEY_SPP_OK, JSON.stringify(sppManualOk));
    else LS.removeItem(STORAGE_KEY_SPP_OK);

    if(Object.keys(scannedExtraRows).length) LS.setItem(STORAGE_KEY_SCANNED_EXTRA, JSON.stringify(scannedExtraRows));
    else LS.removeItem(STORAGE_KEY_SCANNED_EXTRA);

    if(scannedGiSet.size) LS.setItem(STORAGE_KEY_SCANNED_GI, JSON.stringify([...scannedGiSet]));
    else LS.removeItem(STORAGE_KEY_SCANNED_GI);

    if(giScanLog.length) LS.setItem(STORAGE_KEY_GI_LOG, JSON.stringify(giScanLog));
    else LS.removeItem(STORAGE_KEY_GI_LOG);

    if(contShipData) LS.setItem(STORAGE_KEY_CONT_SHIP, JSON.stringify(contShipSerialize(contShipData)));
    else LS.removeItem(STORAGE_KEY_CONT_SHIP);

    if(Object.keys(itemCbmLibrary).length) LS.setItem(STORAGE_KEY_ITEM_CBM, JSON.stringify(itemCbmLibrary));
    else LS.removeItem(STORAGE_KEY_ITEM_CBM);

    if(Object.keys(khoGridLayouts).length) LS.setItem(STORAGE_KEY_KHO_GRID, JSON.stringify(khoGridLayouts));
    else LS.removeItem(STORAGE_KEY_KHO_GRID);

    if(Object.keys(confirmedHistory).length) LS.setItem(STORAGE_KEY_CONFIRMED_HISTORY, JSON.stringify(confirmedHistory));
    else LS.removeItem(STORAGE_KEY_CONFIRMED_HISTORY);

    if(Object.keys(txTransferChecked).length) LS.setItem(STORAGE_KEY_TX_TRANSFER_CHECKED, JSON.stringify(txTransferChecked));
    else LS.removeItem(STORAGE_KEY_TX_TRANSFER_CHECKED);
  }catch(err){
    console.warn('Không lưu được trạng thái:', err);
  }
}

// Lưu RIÊNG ktInputValues (giá trị đang gõ ở các ô "Kiểm thực tế"), có TRÌ HOÃN (debounce) — dùng cho
// đường gõ phím tần suất cao (mỗi ký tự gõ đều gọi) thay vì saveStateToStorage() (tốn kém: stringify
// LẠI TOÀN BỘ dữ liệu tồn kho hàng nghìn dòng mỗi lần gõ, dù chỉ 1 ô số thay đổi — thực đo gây giật
// khi gõ trên máy/tablet yếu). Các nơi khác (Xác nhận dòng, Lưu tổng thể...) vẫn dùng
// saveStateToStorage() như cũ để đảm bảo lưu đủ mọi state liên quan.
let _ktInputSaveTimer = null;
function saveKtInputValuesDebounced(){
  clearTimeout(_ktInputSaveTimer);
  _ktInputSaveTimer = setTimeout(() => {
    if(!STORAGE_OK) return;
    try{
      if(Object.keys(ktInputValues).length) LS.setItem(STORAGE_KEY_KT_INPUTS, JSON.stringify(ktInputValues));
      else LS.removeItem(STORAGE_KEY_KT_INPUTS);
    }catch(err){
      console.warn('Không lưu được ktInputValues:', err);
    }
  }, 400);
}

function loadStateFromStorage(){
  if(!STORAGE_OK) return { inv: null, plans: {}, meta: null, confirmed: {} };
  try{
    const invRaw = LS.getItem(STORAGE_KEY_INVENTORY);
    const plansRaw = LS.getItem(STORAGE_KEY_PLANS);
    const metaRaw = LS.getItem(STORAGE_KEY_META);
    const confirmedRaw = LS.getItem(STORAGE_KEY_CONFIRMED);
    const lastCheckRaw = LS.getItem(STORAGE_KEY_LASTCHECK);
    const invSnapshotRaw = LS.getItem(STORAGE_KEY_INVSNAPSHOT);
    const ccResultsRaw = LS.getItem(STORAGE_KEY_CCRESULTS);
    const manualPickedRaw = LS.getItem(STORAGE_KEY_MANUAL_PICKED);
    const hiddenContRaw = LS.getItem(STORAGE_KEY_HIDDEN_CONT);
    const contCommentsRaw = LS.getItem(STORAGE_KEY_CONT_COMMENTS);
    const planChangeInfoRaw = LS.getItem(STORAGE_KEY_PLAN_CHANGE_INFO);
    const manualKhoRaw = LS.getItem(STORAGE_KEY_MANUAL_KHO);
    const sppOkRaw = LS.getItem(STORAGE_KEY_SPP_OK);
    const ktInputsRaw = LS.getItem(STORAGE_KEY_KT_INPUTS);
    const scannedExtraRaw = LS.getItem(STORAGE_KEY_SCANNED_EXTRA);
    const scannedGiRaw = LS.getItem(STORAGE_KEY_SCANNED_GI);
    const giLogRaw = LS.getItem(STORAGE_KEY_GI_LOG);
    const contShipRaw = LS.getItem(STORAGE_KEY_CONT_SHIP);
    const itemCbmRaw = LS.getItem(STORAGE_KEY_ITEM_CBM);
    const khoGridRaw = LS.getItem(STORAGE_KEY_KHO_GRID);
    const confirmedHistoryRaw = LS.getItem(STORAGE_KEY_CONFIRMED_HISTORY);
    const txTransferCheckedRaw = LS.getItem(STORAGE_KEY_TX_TRANSFER_CHECKED);
    return {
      inv: invRaw ? JSON.parse(invRaw, jsonReviver) : null,
      plans: plansRaw ? JSON.parse(plansRaw, jsonReviver) : {},
      meta: metaRaw ? JSON.parse(metaRaw) : null,
      confirmed: confirmedRaw ? JSON.parse(confirmedRaw, jsonReviver) : {},
      lastCheck: lastCheckRaw ? JSON.parse(lastCheckRaw) : {},
      invSnapshot: invSnapshotRaw ? JSON.parse(invSnapshotRaw) : {},
      ccResults: ccResultsRaw ? JSON.parse(ccResultsRaw) : {},
      manualPicked: manualPickedRaw ? JSON.parse(manualPickedRaw) : {},
      hiddenContainers: hiddenContRaw ? JSON.parse(hiddenContRaw) : {},
      contComments: contCommentsRaw ? JSON.parse(contCommentsRaw) : {},
      planChangeInfo: planChangeInfoRaw ? JSON.parse(planChangeInfoRaw) : {},
      manualKho: manualKhoRaw ? JSON.parse(manualKhoRaw) : {},
      sppOk: sppOkRaw ? JSON.parse(sppOkRaw) : {},
      ktInputs: ktInputsRaw ? JSON.parse(ktInputsRaw) : {},
      scannedExtra: scannedExtraRaw ? JSON.parse(scannedExtraRaw) : {},
      scannedGi: scannedGiRaw ? JSON.parse(scannedGiRaw) : [],
      giScanLog: giLogRaw ? JSON.parse(giLogRaw) : [],
      contShip: contShipRaw ? contShipDeserialize(JSON.parse(contShipRaw)) : null,
      itemCbm: itemCbmRaw ? JSON.parse(itemCbmRaw) : {},
      khoGrid: khoGridRaw ? JSON.parse(khoGridRaw) : {},
      confirmedHistory: confirmedHistoryRaw ? JSON.parse(confirmedHistoryRaw) : {},
      txTransferChecked: txTransferCheckedRaw ? JSON.parse(txTransferCheckedRaw) : {}
    };
  }catch(err){
    console.warn('Không đọc được dữ liệu đã lưu:', err);
    return { inv: null, plans: {}, meta: null, confirmed: {}, lastCheck: {}, invSnapshot: {}, ccResults: {}, manualPicked: {}, hiddenContainers: {}, contComments: {}, planChangeInfo: {}, manualKho: {}, sppOk: {}, ktInputs: {}, scannedExtra: {}, scannedGi: [], giScanLog: [], contShip: null, itemCbm: {}, khoGrid: {}, confirmedHistory: {}, txTransferChecked: {} };
  }
}

function clearStoredState(){
  if(!STORAGE_OK) return;
  LS.removeItem(STORAGE_KEY_INVENTORY);
  LS.removeItem(STORAGE_KEY_PLANS);
  LS.removeItem(STORAGE_KEY_META);
  LS.removeItem(STORAGE_KEY_CONFIRMED);
  LS.removeItem(STORAGE_KEY_LASTCHECK);
  LS.removeItem(STORAGE_KEY_INVSNAPSHOT);
  LS.removeItem(STORAGE_KEY_CCRESULTS);
  LS.removeItem(STORAGE_KEY_MANUAL_PICKED);
  LS.removeItem(STORAGE_KEY_HIDDEN_CONT);
  LS.removeItem(STORAGE_KEY_CONT_COMMENTS);
  LS.removeItem(STORAGE_KEY_PLAN_CHANGE_INFO);
  LS.removeItem(STORAGE_KEY_MANUAL_KHO);
  LS.removeItem(STORAGE_KEY_SPP_OK);
  LS.removeItem(STORAGE_KEY_KT_INPUTS);
  LS.removeItem(STORAGE_KEY_SCANNED_EXTRA);
  LS.removeItem(STORAGE_KEY_SCANNED_GI);
  LS.removeItem(STORAGE_KEY_GI_LOG);
  LS.removeItem(STORAGE_KEY_CONT_SHIP);
  LS.removeItem(STORAGE_KEY_ITEM_CBM);
  LS.removeItem(STORAGE_KEY_KHO_GRID);
  LS.removeItem(STORAGE_KEY_CONFIRMED_HISTORY);
}

let currentFileName = null;
// Tăng số này (và cập nhật ngày) mỗi lần sửa file — hiện trong Cài đặt ⚙️ để biết đang chạy đúng bản
// mới nhất chưa, hay trình duyệt/PWA vẫn đang dùng bản cache cũ chưa kịp cập nhật.
const APP_VERSION = 'v2.59';
const APP_VERSION_DATE = '19/09/2026';
// TRUE khi CHÍNH máy này vừa tải file tồn kho mới (chưa kịp Lưu lên Cloud) — dùng để biết trước khi
// bấm "Lưu": nếu máy này KHÔNG tự thay đổi tồn kho, mà Cloud đang có bản tồn kho khác (do máy khác
// vừa lưu) thì phải LẤY bản đó thay vì lỡ tay đẩy bản CŨ đang cache trên máy này đè lên Cloud.
let _localInventoryDirty = false;
// Tương tự _localInventoryDirty nhưng cho dữ liệu Transaction (Ship) — TRUE khi CHÍNH máy này vừa tải
// file Ship mới (chưa kịp Lưu lên Cloud).
let _localShipDirty = false;
// Dùng chung cho 3 loại tuỳ chỉnh trên bảng Picking Status: Kho chọn tay (manualKhoOverrides), đánh
// dấu Pick xong tay (manualPickedContainers), ẩn/khôi phục container (hiddenPlanContainers) — TRUE khi
// CHÍNH máy này vừa tự đổi 1 trong 3 thứ này (chưa kịp Lưu lên Cloud), y hệt lý do có
// _localInventoryDirty/_localShipDirty: tránh máy khác lỡ tay đẩy bản CŨ đè lên bản mới khi bấm Lưu.
let _localContOverridesDirty = false;

/* ============ dữ liệu gốc nhúng sẵn (rút gọn để demo) ============ */
const DEFAULT_DATA = {"snapshot_date": "—", "total_qty": 0, "distinct_items": 0, "distinct_locators": 0, "distinct_pallets": 0, "n_rows": 0, "pass_qty": 0, "ng_qty": 0, "kho_order": ["Kho 2B", "Kho 3A", "Kho 3B", "Kho DG1"], "qty_by_kho": {"Kho 2B": 0, "Kho 3A": 0, "Kho 3B": 0, "Kho DG1": 0}, "kho_oqc": {"Kho 2B": {"PASS": 0, "NG": 0}, "Kho 3A": {"PASS": 0, "NG": 0}, "Kho 3B": {"PASS": 0, "NG": 0}, "Kho DG1": {"PASS": 0, "NG": 0}}, "top_buyers": [], "other_buyers_qty": 0, "top_items": [], "top_locators": [], "aging": [], "kho_detail": {"Kho 2B": [], "Kho 3A": [], "Kho 3B": [], "Kho DG1": []}, "pallet_by_kho": {"Kho 2B": 0, "Kho 3A": 0, "Kho 3B": 0, "Kho DG1": 0}, "kho_oqc_pallet": {"Kho 2B": {"PASS": 0, "NG": 0}, "Kho 3A": {"PASS": 0, "NG": 0}, "Kho 3B": {"PASS": 0, "NG": 0}, "Kho DG1": {"PASS": 0, "NG": 0}}};

/* ============ tiện ích ============ */
const fmt = n => Math.round(n).toLocaleString('en-US');
const GROUP_COLOR_PALETTE = ['#5B7A3F','#2C4E7C','#B7861F','#6B6B6B','#A1481F','#2C6FCB','#6E4FE0','#0E8F76','#8C5A2B','#4A5C7A'];
function hexToRgba(hex, alpha){
  const h = hex.replace('#','');
  const r = parseInt(h.substring(0,2),16), g = parseInt(h.substring(2,4),16), b = parseInt(h.substring(4,6),16);
  return `rgba(${r},${g},${b},${alpha})`;
}
const fmtDec = (v, dec=2) => {
  if(v === null || v === undefined || v === '') return '—';
  const n = Number(v);
  return isNaN(n) ? String(v) : n.toLocaleString('en-US', {minimumFractionDigits:0, maximumFractionDigits:dec});
};
const fmtDate = d => { const p = n=>String(n).padStart(2,'0'); return `${p(d.getUTCDate())}/${p(d.getUTCMonth()+1)}/${d.getUTCFullYear()}`; };
const pct = (a,b) => b ? (100*a/b).toFixed(1)+'%' : '0%';

// TRÌ HOÃN (debounce) 1 hàm — dùng cho các ô tìm kiếm gõ nhanh (mỗi ký tự gõ đều trigger vẽ lại
// nhiều bảng/sơ đồ cùng lúc) để không vẽ lại NGAY từng ký tự, chỉ vẽ lại sau khi ngừng gõ 1 chút —
// giảm giật khi gõ trên bộ dữ liệu tồn kho lớn (hàng nghìn dòng).
function debounce(fn, wait){
  let timer = null;
  return function(...args){
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), wait);
  };
}

function fmtDateTime(d){
  const p = n => String(n).padStart(2,'0');
  return `${p(d.getDate())}/${p(d.getMonth()+1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function touchUpdatedAt(fileName){
  const el = document.getElementById('updated-at-line');
  if(el) el.textContent = `Cập nhật lúc ${fmtDateTime(new Date())}`;
  if(fileName !== undefined){
    const fEl = document.getElementById('uploaded-file-line');
    if(fEl){ fEl.textContent = `File: ${fileName}`; fEl.title = fileName; }
  }
}

/* ============ GI No. → mã QR (nhấn vào số GI để hiện QR) ============ */
const LIB_QRCODE_OK = typeof QRCode !== 'undefined';
const LIB_EXCELJS_OK = typeof ExcelJS !== 'undefined';
const LIB_JSZIP_OK = typeof JSZip !== 'undefined';
const QR_EXPORT_PX = 135; // kích thước ảnh QR khi xuất Excel (135 x 135 px)

/* 1 vùng ẩn dùng chung (tái sử dụng) để render QR ra canvas rồi đọc lại thành PNG base64 —
   nhanh hơn nhiều so với tạo/xoá DOM cho từng dòng. */
let _qrHiddenHolder = null;
function _getQrHolder(){
  if(!_qrHiddenHolder){
    _qrHiddenHolder = document.createElement('div');
    _qrHiddenHolder.style.cssText = `position:fixed; left:-9999px; top:-9999px; width:${QR_EXPORT_PX}px; height:${QR_EXPORT_PX}px;`;
    document.body.appendChild(_qrHiddenHolder);
  }
  return _qrHiddenHolder;
}
const _qrDataUrlCache = new Map(); // cache theo nội dung text — tránh vẽ lại QR trùng GI No.

/* Tạo ảnh QR (PNG base64), dùng để nhúng vào file Excel xuất ra.
   qrcodejs vẽ canvas đồng bộ nên đọc toDataURL ngay, không cần chờ requestAnimationFrame. */
function generateQrDataUrl(text){
  const key = String(text);
  if(_qrDataUrlCache.has(key)) return _qrDataUrlCache.get(key);
  if(!LIB_QRCODE_OK) return null;
  const holder = _getQrHolder();
  holder.innerHTML = '';
  let dataUrl = null;
  try{
    new QRCode(holder, { text: key, width: QR_EXPORT_PX, height: QR_EXPORT_PX, correctLevel: QRCode.CorrectLevel.M });
    const canvas = holder.querySelector('canvas');
    dataUrl = canvas ? canvas.toDataURL('image/png') : null;
  }catch(err){ dataUrl = null; }
  _qrDataUrlCache.set(key, dataUrl);
  return dataUrl;
}

function giCellHtml(giValue){
  const v = (giValue === null || giValue === undefined) ? '' : String(giValue).trim();
  if(!v) return '—';
  const esc = v.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  return `<span class="gi-clickable" data-gi="${esc}" title="Nhấn để xem mã QR">${esc}</span>`;
}
function showGiQrModal(giValue){
  const overlay = document.getElementById('gi-qr-overlay');
  const valueEl = document.getElementById('gi-qr-value');
  const canvasWrap = document.getElementById('gi-qr-canvas');
  if(!overlay || !canvasWrap) return;
  if(valueEl) valueEl.textContent = giValue;
  canvasWrap.innerHTML = '';
  if(LIB_QRCODE_OK){
    new QRCode(canvasWrap, { text: String(giValue), width: 220, height: 220, correctLevel: QRCode.CorrectLevel.M });
  } else {
    canvasWrap.innerHTML = '<div style="font-size:12px; color:var(--muted); padding:20px;">Không tải được thư viện tạo mã QR (cần Internet).</div>';
  }
  overlay.classList.add('show');
}
function closeGiQrModal(){
  const overlay = document.getElementById('gi-qr-overlay');
  if(overlay) overlay.classList.remove('show');
}
document.addEventListener('click', (e) => {
  const trigger = e.target.closest('.gi-clickable');
  if(trigger){ showGiQrModal(trigger.dataset.gi); return; }
  if(e.target.id === 'gi-qr-overlay' || e.target.closest('#gi-qr-close')) closeGiQrModal();
});
document.addEventListener('keydown', (e) => { if(e.key === 'Escape') closeGiQrModal(); });

/* ---- Modal Cài đặt lưu trữ & đồng bộ (mở từ nút bánh răng trên sidebar) ---- */
function showSettingsModal(){
  const overlay = document.getElementById('settings-overlay');
  if(overlay) overlay.classList.add('show');
  const el = document.getElementById('app-version-status');
  if(el) el.textContent = `${APP_VERSION} — cập nhật lần cuối: ${APP_VERSION_DATE}`;
}
function closeSettingsModal(){
  const overlay = document.getElementById('settings-overlay');
  if(overlay) overlay.classList.remove('show');
}
const settingsOpenBtn = document.getElementById('settings-open-btn');
if(settingsOpenBtn) settingsOpenBtn.addEventListener('click', showSettingsModal);
document.addEventListener('click', (e) => {
  if(e.target.id === 'settings-overlay' || e.target.closest('#settings-close')) closeSettingsModal();
});
document.addEventListener('keydown', (e) => { if(e.key === 'Escape') closeSettingsModal(); });

/* ---- Khoá bớt tab trên sidebar — mặc định chỉ hiện Picking/Tìm mã hàng/Kiểm tồn kho,
   nhập đúng mật khẩu trong Cài đặt mới hiện lại toàn bộ. Chỉ mang tính ẩn bớt cho gọn,
   KHÔNG phải bảo mật thật sự (code vẫn chạy phía client). ---- */
const APP_LOCK_PASSWORD = '123465';
const APP_LOCK_RESTRICTED_PAGES = ['overview', 'sodo3b', 'transaction', 'compare'];
const STORAGE_KEY_APP_UNLOCKED = 'tn5_dashboard_app_unlocked_v1';
function isAppUnlocked(){
  try{ return localStorage.getItem(STORAGE_KEY_APP_UNLOCKED) === '1'; }catch(e){ return false; }
}
function applyAppLockUI(){
  const unlocked = isAppUnlocked();
  APP_LOCK_RESTRICTED_PAGES.forEach(p => {
    const btn = document.querySelector(`.sidebar-nav-btn[data-page="${p}"]`);
    if(btn) btn.style.display = unlocked ? '' : 'none';
  });
  if(!unlocked){
    const activeBtn = document.querySelector('.sidebar-nav-btn.active[data-page]');
    const activePage = activeBtn ? activeBtn.dataset.page : null;
    if(activePage && APP_LOCK_RESTRICTED_PAGES.includes(activePage)){
      const fallbackBtn = document.querySelector('.sidebar-nav-btn[data-page="picking"]');
      if(fallbackBtn) fallbackBtn.click();
    }
  }
}
function appLockTryUnlock(){
  const input = document.getElementById('app-lock-password-input');
  const statusEl = document.getElementById('app-lock-status');
  if(!input) return;
  if(input.value === APP_LOCK_PASSWORD){
    try{ localStorage.setItem(STORAGE_KEY_APP_UNLOCKED, '1'); }catch(e){}
    input.value = '';
    if(statusEl){ statusEl.textContent = '✓ Đã mở khoá — hiện đầy đủ các tab.'; statusEl.style.color = 'var(--teal)'; }
    applyAppLockUI();
  } else {
    if(statusEl){ statusEl.textContent = '✗ Sai mật khẩu.'; statusEl.style.color = 'var(--red)'; }
  }
}
function appLockLockAgain(){
  try{ localStorage.removeItem(STORAGE_KEY_APP_UNLOCKED); }catch(e){}
  const statusEl = document.getElementById('app-lock-status');
  if(statusEl){ statusEl.textContent = 'Đã khoá lại — chỉ còn hiện Picking / Tìm mã hàng / Kiểm tồn kho / Màn hình kho.'; statusEl.style.color = 'var(--muted-2)'; }
  applyAppLockUI();
}
const appLockUnlockBtn = document.getElementById('app-lock-unlock-btn');
if(appLockUnlockBtn) appLockUnlockBtn.addEventListener('click', appLockTryUnlock);
const appLockLockBtn = document.getElementById('app-lock-lock-btn');
if(appLockLockBtn) appLockLockBtn.addEventListener('click', appLockLockAgain);
const appLockPasswordInput = document.getElementById('app-lock-password-input');
if(appLockPasswordInput) appLockPasswordInput.addEventListener('keydown', (e) => { if(e.key === 'Enter') appLockTryUnlock(); });

// Nút "🔒 Khoá trang ngay" (mục Cài đặt) — khoá truy cập NGAY LẬP TỨC, dù đang trong giờ ca, bằng
// cách bật cờ tn5_gate_manual_lock (đọc bởi khối chặn ca ở đầu <body> và ở lock.html) rồi điều
// hướng thẳng sang lock.html — điều hướng thật sự là cách DUY NHẤT chặn chắc chắn (xem lý do đầy đủ
// ở khối chặn ca đầu file). Mở lại được bằng đúng mật khẩu ở lock.html (nút "Mở truy cập ngay"/"Đổi
// lịch ca" đều tự xoá cờ này luôn, xem lock.html).
const btnGateLockNow = document.getElementById('btn-gate-lock-now');
if(btnGateLockNow) btnGateLockNow.addEventListener('click', async () => {
  const cloudActive = typeof CloudVault !== 'undefined' && CloudVault.url && CloudVault.token;
  const msg = cloudActive
    ? 'Khoá trang ngay lập tức trên TẤT CẢ thiết bị đang dùng chung Cloud? Mọi người (kể cả bạn) sẽ cần đúng mật khẩu để mở lại.'
    : 'Khoá trang ngay lập tức TRÊN MÁY NÀY? (chưa kết nối Cloud nên chỉ khoá được máy này, không đồng bộ sang máy khác). Cần đúng mật khẩu để mở lại.';
  if(!confirm(msg)) return;
  try{ localStorage.setItem('tn5_gate_manual_lock', '1'); }catch(e){}
  // Đẩy lên Cloud để các thiết bị khác cũng bị khoá theo (nếu có kết nối Cloud) — đợi TỐI ĐA 2 giây,
  // không để lỡ mạng chậm làm treo mãi nút này; máy khác vẫn sẽ tự bắt được cờ khoá qua kiểm tra nền
  // (gateFetchCloudConfig) ngay lần tải trang / mỗi 30 giây tiếp theo dù request này có kịp hay không.
  if(cloudActive){
    try{
      await Promise.race([
        gateWriteCloudConfig({ manualLock: true }),
        new Promise(resolve => setTimeout(resolve, 2000))
      ]);
    }catch(e){}
  }
  location.replace(gateBustedUrl('lock.html'));
});

const MONTHS = {jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11};

function excelSerialToDate(serial){
  const ms = Math.round((serial - 25569) * 86400 * 1000);
  return new Date(ms);
}

function parseDateCell(v){
  if(v === null || v === undefined || v === '') return null;
  if(v instanceof Date && !isNaN(v)) return v;
  if(typeof v === 'number') return excelSerialToDate(v);
  if(typeof v === 'string'){
    const s = v.trim();
    let m = s.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})/);
    if(m){
      const mon = MONTHS[m[2].toLowerCase()];
      if(mon !== undefined) return new Date(Date.UTC(Number(m[3]), mon, Number(m[1])));
    }
    let m3 = s.match(/^(\d{1,2})-([A-Za-z]{3})$/);
    if(m3){
      const mon = MONTHS[m3[2].toLowerCase()];
      if(mon !== undefined) return new Date(Date.UTC(new Date().getFullYear(), mon, Number(m3[1])));
    }
    let m2 = s.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
    if(m2){
      const day = Number(m2[1]), month = Number(m2[2]) - 1;
      let year = m2[3] ? Number(m2[3]) : new Date().getFullYear();
      if(year < 100) year += 2000;
      if(month >= 0 && month <= 11 && day >= 1 && day <= 31) return new Date(Date.UTC(year, month, day));
    }
    const d = new Date(s);
    if(!isNaN(d)) return d;
  }
  return null;
}

function formatTimeCell(v){
  if(v === null || v === undefined || v === '') return '';
  const pad = n => String(n).padStart(2,'0');
  if(v instanceof Date && !isNaN(v)) return `${pad(v.getUTCHours())}:${pad(v.getUTCMinutes())}`;
  if(typeof v === 'number'){
    const totalMin = Math.round((v % 1) * 24 * 60);
    return `${pad(Math.floor(totalMin/60))}:${pad(totalMin%60)}`;
  }
  return String(v).trim();
}

function parseNumber(v){
  if(v === null || v === undefined || v === '') return 0;
  if(typeof v === 'number') return v;
  const cleaned = String(v).trim().replace(/[^0-9.\-]/g, '');
  const n = parseFloat(cleaned);
  return isNaN(n) ? 0 : n;
}

function normalizeItemCode(v){
  const s = String(v).trim();
  if(/^\d+$/.test(s) && s.length > 0 && s.length < 9) return s.padStart(9, '0');
  return s;
}

function classifyKho(locator){
  if(!locator) return 'Chua phan loai';
  const l = String(locator).toUpperCase();
  if(l.includes('3B')) return 'Kho 3B';
  if(l.includes('3A') || l.includes('DG3')) return 'Kho 3A';
  if(l.includes('2B') || l.includes('DG2')) return 'Kho 2B';
  if(l.includes('DG1')) return 'Kho DG1';
  return 'Chua phan loai';
}

const VN_DIACRITICS_MAP = {
  'à':'a','á':'a','ả':'a','ã':'a','ạ':'a','ă':'a','ằ':'a','ắ':'a','ẳ':'a','ẵ':'a','ặ':'a','â':'a','ầ':'a','ấ':'a','ẩ':'a','ẫ':'a','ậ':'a',
  'è':'e','é':'e','ẻ':'e','ẽ':'e','ẹ':'e','ê':'e','ề':'e','ế':'e','ể':'e','ễ':'e','ệ':'e',
  'ì':'i','í':'i','ỉ':'i','ĩ':'i','ị':'i',
  'ò':'o','ó':'o','ỏ':'o','õ':'o','ọ':'o','ô':'o','ồ':'o','ố':'o','ổ':'o','ỗ':'o','ộ':'o','ơ':'o','ờ':'o','ớ':'o','ở':'o','ỡ':'o','ợ':'o',
  'ù':'u','ú':'u','ủ':'u','ũ':'u','ụ':'u','ư':'u','ừ':'u','ứ':'u','ử':'u','ữ':'u','ự':'u',
  'ỳ':'y','ý':'y','ỷ':'y','ỹ':'y','ỵ':'y',
  'đ':'d',
  'À':'A','Á':'A','Ả':'A','Ã':'A','Ạ':'A','Ă':'A','Ằ':'A','Ắ':'A','Ẳ':'A','Ẵ':'A','Ặ':'A','Â':'A','Ầ':'A','Ấ':'A','Ẩ':'A','Ẫ':'A','Ậ':'A',
  'È':'E','É':'E','Ẻ':'E','Ẽ':'E','Ẹ':'E','Ê':'E','Ề':'E','Ế':'E','Ể':'E','Ễ':'E','Ệ':'E',
  'Ì':'I','Í':'I','Ỉ':'I','Ĩ':'I','Ị':'I',
  'Ò':'O','Ó':'O','Ỏ':'O','Õ':'O','Ọ':'O','Ô':'O','Ồ':'O','Ố':'O','Ổ':'O','Ỗ':'O','Ộ':'O','Ơ':'O','Ờ':'O','Ớ':'O','Ở':'O','Ỡ':'O','Ợ':'O',
  'Ù':'U','Ú':'U','Ủ':'U','Ũ':'U','Ụ':'U','Ư':'U','Ừ':'U','Ứ':'U','Ử':'U','Ữ':'U','Ự':'U',
  'Ỳ':'Y','Ý':'Y','Ỷ':'Y','Ỹ':'Y','Ỵ':'Y',
  'Đ':'D',
};
function removeDiacritics(str){
  let out = '';
  for(let i=0;i<str.length;i++){
    const c = str[i];
    out += VN_DIACRITICS_MAP[c] || c;
  }
  return out;
}

function findCol(headers, candidates){
  const norm = h => removeDiacritics((h||'').toString().toLowerCase().trim()).replace(/\s+/g, ' ');
  const lower = headers.map(norm);
  for(const cand of candidates){
    const idx = lower.findIndex(h => h === norm(cand));
    if(idx !== -1) return idx;
  }
  for(const cand of candidates){
    const idx = lower.findIndex(h => h.includes(norm(cand)));
    if(idx !== -1) return idx;
  }
  return -1;
}

function decodeTextBuffer(buffer){
  const bytes = new Uint8Array(buffer);
  if(bytes.length >= 2 && bytes[0] === 0xFF && bytes[1] === 0xFE){
    return new TextDecoder('utf-16le').decode(buffer);
  }
  if(bytes.length >= 2 && bytes[0] === 0xFE && bytes[1] === 0xFF){
    return new TextDecoder('utf-16be').decode(buffer);
  }
  if(bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF){
    return new TextDecoder('utf-8').decode(buffer);
  }
  const sampleLen = Math.min(bytes.length, 4000);
  let evenZero = 0, oddZero = 0;
  for(let i=0;i<sampleLen;i++){
    if(bytes[i] === 0){ if(i % 2 === 0) evenZero++; else oddZero++; }
  }
  if((evenZero + oddZero) > sampleLen * 0.25){
    return oddZero >= evenZero ? new TextDecoder('utf-16le').decode(buffer) : new TextDecoder('utf-16be').decode(buffer);
  }
  return new TextDecoder('utf-8').decode(buffer);
}

function parseDelimitedText(text, delim){
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let fieldStart = true; // true khi chưa có ký tự nào được thêm vào field hiện tại
  if(text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  for(let i=0;i<text.length;i++){
    const c = text[i];
    if(inQuotes){
      if(c === '"'){
        if(text[i+1] === '"'){ field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else {
      // Chỉ coi " là ký tự mở ngoặc trích dẫn CSV nếu nó nằm ở NGAY ĐẦU field (đúng chuẩn CSV/TSV).
      // Nếu " xuất hiện giữa field (VD: ký hiệu inch trong mô tả sản phẩm như 42" TRACTOR),
      // phải giữ nguyên là ký tự bình thường, không được coi là bắt đầu vùng trích dẫn —
      // nếu không sẽ nuốt mất tab/xuống dòng phía sau, làm hỏng toàn bộ cấu trúc file.
      if(c === '"' && fieldStart){ inQuotes = true; }
      else if(c === delim){ row.push(field); field = ''; fieldStart = true; continue; }
      else if(c === '\n'){ row.push(field); rows.push(row); row = []; field = ''; fieldStart = true; continue; }
      else if(c === '\r'){ continue; }
      else field += c;
      fieldStart = false;
    }
  }
  if(field.length || row.length){ row.push(field); rows.push(row); }
  return rows.filter(r => !(r.length === 1 && r[0] === ''));
}

function guessDelimiter(text){
  const firstLine = text.split(/\r?\n/, 1)[0] || '';
  const counts = { ',': (firstLine.match(/,/g)||[]).length, '\t': (firstLine.match(/\t/g)||[]).length, ';': (firstLine.match(/;/g)||[]).length };
  return Object.entries(counts).sort((a,b)=>b[1]-a[1])[0][0];
}

function extractRawRows(workbook){
  let sheetName = workbook.SheetNames.find(n => n.trim().toLowerCase() === 'du lieu goc');
  let best = null;
  if(!sheetName){
    for(const name of workbook.SheetNames){
      const rows = XLSX.utils.sheet_to_json(workbook.Sheets[name], {header:1, raw:true, defval:null});
      if(!rows.length) continue;
      const headerIdx = findCol(rows[0], ['item']);
      if(headerIdx === -1) continue;
      if(!best || rows.length > best.rows.length) best = {name, rows};
    }
    if(!best) throw new Error('Không tìm thấy sheet dữ liệu phù hợp (cần cột "Item No.").');
    return best;
  }
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], {header:1, raw:true, defval:null});
  return {name: sheetName, rows};
}

function computeAggregates(rows){
  if(!rows.length) throw new Error('File không có dữ liệu.');
  const headers = rows[0];
  const colItem   = findCol(headers, ['item no', 'item number', 'item', 'ma hang', 'ma hh', 'sku', 'part no', 'part number', 'material']);
  const colLoc    = findCol(headers, ['locator name', 'locator', 'vi tri', 'location', 'warehouse loc', 'bin']);
  const colQty    = findCol(headers, ['onhand qty', 'onhand', 'on hand', 'so luong ton', 'so luong', 'qty', 'quantity']);
  const colOqc    = findCol(headers, ['oqc status', 'oqc', 'qc status', 'status']);
  const colBuyer  = findCol(headers, ['end buyer', 'buyer', 'khach hang', 'customer']);
  const colCustPo = findCol(headers, ['cust po', 'customer po', 'cust. po', 'po khach hang', 'po number', 'so po', 'po no']);
  const colDate   = findCol(headers, ['receive date', 'ngay nhap', 'ngay nhan', 'date']);
  const colPallet = findCol(headers, ['pallet']);
  const colGI     = findCol(headers, ['gi no', 'gi number', 'gi']);
  const colLot    = findCol(headers, ['lot no', 'lot number', 'lot']);
  const colRef    = findCol(headers, ['reference', 'ref', 'csr']);

  if(colItem === -1 || colLoc === -1 || colQty === -1){
    const found = headers.map((h,i) => `[${i}] "${h ?? ''}"`).join('  ');
    const missing = [
      colItem === -1 ? 'Mã hàng / Item No.' : null,
      colLoc === -1 ? 'Vị trí / Locator Name' : null,
      colQty === -1 ? 'Số lượng / Onhand Qty' : null,
    ].filter(Boolean).join(', ');
    throw new Error(`Thiếu cột bắt buộc: ${missing}. Các cột đọc được từ dòng tiêu đề: ${found || '(không đọc được dòng nào)'}`);
  }

  const data = [];
  for(let i=1;i<rows.length;i++){
    const r = rows[i];
    if(!r || r[colItem] === null || r[colItem] === undefined || r[colItem] === '') continue;
    const item = String(r[colItem]).trim();
    const locator = colLoc !== -1 ? (r[colLoc] != null ? String(r[colLoc]).trim() : null) : null;
    const qty = colQty !== -1 ? parseNumber(r[colQty]) : 0;
    const oqc = colOqc !== -1 ? (r[colOqc] != null ? String(r[colOqc]).trim() : null) : null;
    const buyer = (colBuyer !== -1 && r[colBuyer]) ? String(r[colBuyer]).trim() : 'Khac';
    const custpo = (colCustPo !== -1 && r[colCustPo] !== null && r[colCustPo] !== undefined && String(r[colCustPo]).trim() !== '') ? String(r[colCustPo]).trim() : '(Khong co)';
    const dt = colDate !== -1 ? parseDateCell(r[colDate]) : null;
    const pallet = colPallet !== -1 ? r[colPallet] : null;
    const gi = colGI !== -1 && r[colGI] != null ? String(r[colGI]).trim() : '';
    const lot = colLot !== -1 && r[colLot] != null ? String(r[colLot]).trim() : '';
    const ref = colRef !== -1 && r[colRef] != null ? String(r[colRef]).trim() : '';
    const kho = classifyKho(locator);
    data.push({item, locator: locator!=null?String(locator):'—', qty, oqc: oqc || 'Khac', buyer, custpo, dt, pallet, gi, lot, kho, ref});
  }
  if(!data.length) throw new Error('Không đọc được dòng dữ liệu hợp lệ nào.');

  // GỘP các lượt quét độc lập (trước đây ~10 lượt .map()/.filter()/.reduce()/for RIÊNG BIỆT qua toàn
  // bộ `data`) thành 1 VÒNG LẶP DUY NHẤT cập nhật mọi bộ đếm/gộp nhóm cùng lúc — chạy 1 lần trên file
  // tồn kho có thể tới hàng chục nghìn dòng mỗi khi tải file mới, thay vì lặp lại nhiều lần cho cùng 1
  // việc duyệt dữ liệu. KHÔNG đổi kết quả trả về — chỉ đổi cách tính, giá trị từng trường giữ nguyên
  // y hệt logic gốc.
  let total_qty = 0;
  const itemsSet = new Set(), locatorsSet = new Set(), palletsSet = new Set();
  let pass_qty = 0, ng_qty = 0;
  const qty_by_kho = {};
  const kho_oqc = {};
  const pallet_by_kho = {};
  const kho_oqc_pallet = {};
  const by_buyer = {};
  const by_item = {};
  const item_kho = {};
  const by_locator = {};
  const locator_kho = {};
  const kho_item_po = {};
  let maxDt = null;
  const WATCH_LOCATORS_3B = ['D3B-FG-TG', 'D3B-FG-ITN'];
  const WATCH_LOCATORS_3A = ['DG3-FG-TG', 'DG3-FG-ITN'];
  const locator_watch_3b = [];
  const locator_watch_3a = [];
  for(const d of data){
    total_qty += d.qty;
    itemsSet.add(d.item);
    locatorsSet.add(d.locator);
    palletsSet.add(d.pallet);
    if(d.oqc === 'PASS') pass_qty += d.qty;
    else if(d.oqc === 'NG') ng_qty += d.qty;
    qty_by_kho[d.kho] = (qty_by_kho[d.kho]||0) + d.qty;
    kho_oqc[d.kho] = kho_oqc[d.kho] || {};
    const key = d.oqc || 'Khac';
    kho_oqc[d.kho][key] = (kho_oqc[d.kho][key]||0) + d.qty;
    // Mỗi dòng dữ liệu (1 GI No.) tính là 1 pallet — đúng quy ước đang dùng ở sơ đồ kho 3A/3B
    pallet_by_kho[d.kho] = (pallet_by_kho[d.kho]||0) + 1;
    kho_oqc_pallet[d.kho] = kho_oqc_pallet[d.kho] || {};
    kho_oqc_pallet[d.kho][key] = (kho_oqc_pallet[d.kho][key]||0) + 1;

    by_buyer[d.buyer] = (by_buyer[d.buyer]||0) + d.qty;

    by_item[d.item] = (by_item[d.item]||0) + d.qty;
    item_kho[d.item] = item_kho[d.item] || new Set();
    item_kho[d.item].add(d.kho);

    by_locator[d.locator] = (by_locator[d.locator]||0) + d.qty;
    locator_kho[d.locator] = d.kho;

    kho_item_po[d.kho] = kho_item_po[d.kho] || {};
    const poKey = d.item + '␟' + d.custpo + '␟' + (d.locator || '—') + '␟' + (d.oqc || 'Khac') + '␟' + (d.ref || '');
    kho_item_po[d.kho][poKey] = (kho_item_po[d.kho][poKey] || 0) + d.qty;

    if(d.dt && (maxDt === null || d.dt > maxDt)) maxDt = d.dt;

    const locUp = (d.locator || '').toUpperCase();
    if(WATCH_LOCATORS_3B.includes(locUp) || WATCH_LOCATORS_3A.includes(locUp)){
      const watchEntry = { item: d.item, locator: d.locator, qty: d.qty, gi: d.gi, lot: d.lot, pallet: d.pallet != null ? String(d.pallet) : '' };
      if(WATCH_LOCATORS_3B.includes(locUp)) locator_watch_3b.push(watchEntry);
      else locator_watch_3a.push(watchEntry);
    }
  }
  const distinct_items = itemsSet.size;
  const distinct_locators = locatorsSet.size;
  const distinct_pallets = palletsSet.size;
  locator_watch_3b.sort((a,b) => a.locator.localeCompare(b.locator) || b.qty - a.qty);
  locator_watch_3a.sort((a,b) => a.locator.localeCompare(b.locator) || b.qty - a.qty);
  const khoPriority = ['Kho 2B','Kho 3A','Kho 3B','Kho DG1','Chua phan loai'];
  const kho_order = khoPriority.filter(k => qty_by_kho[k] !== undefined)
    .concat(Object.keys(qty_by_kho).filter(k => !khoPriority.includes(k)));

  const top_buyers = Object.entries(by_buyer).sort((a,b)=>b[1]-a[1]).slice(0,8);
  const other_buyers_qty = total_qty - top_buyers.reduce((s,b)=>s+b[1],0);

  const top_items = Object.entries(by_item).sort((a,b)=>b[1]-a[1]).slice(0,12)
    .map(([item,q]) => [item, q, Array.from(item_kho[item])]);

  const top_locators = Object.entries(by_locator).sort((a,b)=>b[1]-a[1]).slice(0,12)
    .map(([loc,q]) => [loc, q, locator_kho[loc]]);

  const kho_detail = {};
  for(const k of Object.keys(kho_item_po)){
    kho_detail[k] = Object.entries(kho_item_po[k])
      .map(([key,qty]) => { const parts = key.split('\u241F'); const [item, custpo, locator, oqc, ref] = parts; return [item, custpo, locator, oqc, qty, ref]; })
      .sort((a,b)=>b[4]-a[4]);
  }

  // "today" (moc tinh tuoi ton kho) lay tu maxDt da gom trong vong lap chinh o tren.
  const today = maxDt || new Date();
  const buckets = [['0-7 ngay',0,7],['8-30 ngay',8,30],['31-60 ngay',31,60],['61-90 ngay',61,90],['>90 ngay',91,999999]];
  const bucket_qty = buckets.map(b => [b[0], 0]);
  for(const d of data){
    if(!d.dt) continue;
    const age = Math.round((today - d.dt) / 86400000);
    for(let i=0;i<buckets.length;i++){
      if(age >= buckets[i][1] && age <= buckets[i][2]){ bucket_qty[i][1] += d.qty; break; }
    }
  }
  const pad = n => String(n).padStart(2,'0');

  return {
    snapshot_date: `${pad(today.getUTCDate())}/${pad(today.getUTCMonth()+1)}/${today.getUTCFullYear()}`,
    total_qty, distinct_items, distinct_locators, distinct_pallets,
    n_rows: data.length, pass_qty, ng_qty, kho_order, qty_by_kho, kho_oqc, pallet_by_kho, kho_oqc_pallet,
    top_buyers, other_buyers_qty, top_items, top_locators, aging: bucket_qty, kho_detail,
    locator_watch_3b,
    locator_watch_3a,
    raw_rows: data.map(d => [
      d.kho, d.item, d.custpo, d.locator, d.oqc, d.qty,
      d.gi || '', d.lot || '', d.pallet != null ? String(d.pallet) : '',
      d.dt ? fmtDate(d.dt) : '', d.buyer || '', d.ref || ''
    ]),
  };
}

let currentData = null;


/* ============================================================
   ============  "Tổng quan sức chứa" — Kho 3B / 3A / 2B  ============
   ============================================================
   Công thức và danh sách locator lấy từ file tham chiếu do người dùng cung cấp
   (Warehouse_Dashboard_FG-DG_FINAL_Hover10_Scroll.html). "Pallet" = số dòng
   (mỗi dòng dữ liệu tồn kho / GI No.) tại locator đó — khớp quy ước đã dùng
   ở các phần khác của dashboard (VD: ccBuildInventoryRows). */

// ---- Kho 3A: Racking (dãy A-E, bay 1-17, tier T1/T2/T3/T5 — không có T4) ----
// Với dãy C/D/E, chỉ T1 và T5 tính vào capacity (T2, T3 bị loại — theo file tham chiếu).
const OV_3A_RACK_LETTERS = ['A','B','C','D','E'];
const OV_3A_RACK_TIERS = [1,2,3,5];
const OV_3A_RACK_CAPACITY_PER_LOC = 2;
function ov3ARackLocators(){
  const arr = [];
  OV_3A_RACK_LETTERS.forEach(l => {
    for(let b=1;b<=17;b++){
      OV_3A_RACK_TIERS.forEach(t => {
        const excluded = (l === 'C' || l === 'D' || l === 'E') && (t === 2 || t === 3);
        if(!excluded) arr.push(`3A-${l}${b}-T${t}`);
      });
    }
  });
  return arr;
}
// ---- Kho 3A: Floor (DG3-FG-A/B/C) ----
function ov3AFloorLocators(){
  const arr = [];
  for(let n=1;n<=15;n++) arr.push('DG3-FG-A' + String(n).padStart(2,'0'));
  for(let n=1;n<=15;n++) arr.push('DG3-FG-B' + String(n).padStart(2,'0'));
  for(let n=1;n<=15;n++) arr.push('DG3-FG-C' + String(n).padStart(2,'0'));
  return arr;
}
function ov3AFloorCapacity(loc){
  const m = String(loc||'').match(/^DG3-FG-([ABC])(\d+)$/i);
  if(!m) return 0;
  const lane = m[1].toUpperCase(), num = Number(m[2]);
  if(lane === 'A' && num >= 1 && num <= 4) return 10;
  if(lane === 'A' && num >= 5 && num <= 15) return 20;
  if(lane === 'B' && num >= 1 && num <= 15) return 20;
  if(lane === 'C' && num >= 1 && num <= 15) return 22;
  return 0;
}
// ---- Kho 3A: Mezzanine M1 ----
function ov3AM1Locators(){
  const arr = [];
  for(let n=1;n<=20;n++) arr.push('3AFG-M1-A' + String(n).padStart(2,'0'));
  return arr;
}
const OV_3A_M1_CAPACITY_PER_LOC = 14;

// Phân nhóm 1 danh sách locator theo % lấp đầy (4 nhóm: trống/thấp/vừa/gần đầy-đầy), đồng thời giữ
// lại chi tiết từng locator trong mỗi nhóm (dùng cho popover khi hover vào "Phân bố trạng thái vị trí").
function ovClassifyBucket4(locs, capOf, counts){
  const groups = [[], [], [], []];
  locs.forEach(l => {
    const q = counts.get(l) || 0, cap = capOf(l) || 0, r = cap ? q / cap : 0;
    const entry = { locator: l, qty: q, capacity: cap };
    if(q === 0) groups[0].push(entry);
    else if(r < 0.5) groups[1].push(entry);
    else if(r < 0.8) groups[2].push(entry);
    else groups[3].push(entry);
  });
  return groups;
}
// Phân nhóm riêng cho Racking 3A (3 nhóm: trống/1 pallet/đầy 2 pallet — sức chứa cố định 2/vị trí,
// có thể bị ghi đè riêng từng vị trí qua nút bánh răng ở trang "Sơ đồ kho").
function ovClassifyBucket3(locs, counts){
  const groups = [[], [], []];
  locs.forEach(l => {
    const q = counts.get(l) || 0;
    const cap = whApplyCapOverride(l, OV_3A_RACK_CAPACITY_PER_LOC);
    const entry = { locator: l, qty: q, capacity: cap };
    if(q <= 0) groups[0].push(entry); else if(q < cap) groups[1].push(entry); else groups[2].push(entry);
  });
  return groups;
}

function ov3AOverview(counts){
  const rackLocs = ov3ARackLocators();
  const floorLocs = ov3AFloorLocators();
  const m1Locs = ov3AM1Locators();
  const rackPallets = rackLocs.reduce((s,l) => s + (counts.get(l)||0), 0);
  const floorPallets = floorLocs.reduce((s,l) => s + (counts.get(l)||0), 0);
  const m1Pallets = m1Locs.reduce((s,l) => s + (counts.get(l)||0), 0);
  const rackCap = rackLocs.reduce((s,l) => s + whApplyCapOverride(l, OV_3A_RACK_CAPACITY_PER_LOC), 0);
  const floorCap = floorLocs.reduce((s,l) => s + whApplyCapOverride(l, ov3AFloorCapacity(l)), 0);
  const m1Cap = m1Locs.reduce((s,l) => s + whApplyCapOverride(l, OV_3A_M1_CAPACITY_PER_LOC), 0);
  const groups = ovClassifyBucket3(rackLocs, counts);
  return {
    pallets: rackPallets + floorPallets + m1Pallets,
    capacity: rackCap + floorCap + m1Cap,
    positions: rackLocs.length + floorLocs.length + m1Locs.length,
    bucketMode: 3,
    buckets: groups.map(g => g.length),
    bucketLocators: groups,
    bucketTotal: rackLocs.length,
    miniKpis: [
      { v: rackPallets + floorPallets + m1Pallets, l: 'PALLET RACKING + FLOOR + M1' },
      { v: rackCap + floorCap + m1Cap, l: 'TỔNG CAPACITY RACKING + FLOOR + M1' }
    ]
  };
}

// ---- Kho 3B: Floor D3B-FG-A01 → A33 (26 pallet/locator cho A01–A17, 24 cho A18–A33) ----
function ovB3FloorLocators(){
  const arr = [];
  for(let n=1;n<=33;n++) arr.push('D3B-FG-A' + String(n).padStart(2,'0'));
  return arr;
}
function ovB3Capacity(loc){
  const m = String(loc||'').match(/^D3B-FG-A(\d+)$/i);
  if(!m) return 0;
  return Number(m[1]) <= 17 ? 26 : 24;
}
const OV_B3_TOTAL_CAPACITY = 826; // chỉ dùng làm mô tả/ghi chú — số thật hiển thị luôn cộng từ từng vị trí (có áp override)

function ovB3Overview(counts){
  const locs = ovB3FloorLocators();
  const pallets = locs.reduce((s,l) => s + (counts.get(l)||0), 0);
  const capOf = l => whApplyCapOverride(l, ovB3Capacity(l));
  const capacity = locs.reduce((s,l) => s + capOf(l), 0);
  const groups = ovClassifyBucket4(locs, capOf, counts);
  return {
    pallets,
    capacity,
    positions: locs.length,
    bucketMode: 4,
    buckets: groups.map(g => g.length),
    bucketLocators: groups,
    bucketTotal: locs.length,
    miniKpis: [
      { v: pallets, l: 'PALLET FLOOR 3B' },
      { v: capacity, l: 'TỔNG CAPACITY' }
    ]
  };
}

// ---- Kho 2B: toàn bộ locator D2B-FG-A→H (trừ D2B-FG-H01 khỏi capacity) ----
const B2_LOCATORS = ["D2B-FG-F12", "D2B-FG-F11", "D2B-FG-F10", "D2B-FG-F09", "D2B-FG-F08", "D2B-FG-F07", "D2B-FG-F06", "D2B-FG-F05", "D2B-FG-F04", "D2B-FG-F03", "D2B-FG-F02", "D2B-FG-F01", "D2B-FG-E12", "D2B-FG-E11", "D2B-FG-E10", "D2B-FG-E09", "D2B-FG-E08", "D2B-FG-E07", "D2B-FG-E06", "D2B-FG-E05", "D2B-FG-E04", "D2B-FG-E03", "D2B-FG-E02", "D2B-FG-E01", "D2B-FG-D12", "D2B-FG-D11", "D2B-FG-D10", "D2B-FG-D09", "D2B-FG-D08", "D2B-FG-D07", "D2B-FG-D06", "D2B-FG-D05", "D2B-FG-D04", "D2B-FG-D03", "D2B-FG-D02", "D2B-FG-D01", "D2B-FG-C12", "D2B-FG-C11", "D2B-FG-C10", "D2B-FG-C09", "D2B-FG-C08", "D2B-FG-C07", "D2B-FG-C06", "D2B-FG-C05", "D2B-FG-C04", "D2B-FG-C03", "D2B-FG-C02", "D2B-FG-C01", "D2B-FG-G06", "D2B-FG-G05", "D2B-FG-G04", "D2B-FG-G03", "D2B-FG-G02", "D2B-FG-G01", "D2B-FG-B11", "D2B-FG-B10", "D2B-FG-B09", "D2B-FG-B08", "D2B-FG-B07", "D2B-FG-B06", "D2B-FG-B05", "D2B-FG-B04", "D2B-FG-B03", "D2B-FG-B02", "D2B-FG-B01", "D2B-FG-A12", "D2B-FG-A11", "D2B-FG-A10", "D2B-FG-A09", "D2B-FG-A08", "D2B-FG-A07", "D2B-FG-A06", "D2B-FG-A05", "D2B-FG-A04", "D2B-FG-A03", "D2B-FG-A02", "D2B-FG-A01", "D2B-FG-H01"];
const B2_CAPACITY_MAP = {"D2B-FG-G06": 12, "D2B-FG-G03": 12, "D2B-FG-G05": 24, "D2B-FG-G02": 24, "D2B-FG-G04": 24, "D2B-FG-G01": 24, "D2B-FG-F12": 24, "D2B-FG-D12": 36, "D2B-FG-F11": 16, "D2B-FG-D11": 24, "D2B-FG-B11": 32, "D2B-FG-F10": 16, "D2B-FG-D10": 24, "D2B-FG-B10": 32, "D2B-FG-F09": 16, "D2B-FG-D09": 24, "D2B-FG-B09": 36, "D2B-FG-F08": 16, "D2B-FG-D08": 24, "D2B-FG-B08": 36, "D2B-FG-F07": 16, "D2B-FG-D07": 24, "D2B-FG-B07": 36, "D2B-FG-F06": 16, "D2B-FG-D06": 24, "D2B-FG-B06": 36, "D2B-FG-F05": 16, "D2B-FG-D05": 24, "D2B-FG-B05": 36, "D2B-FG-F04": 16, "D2B-FG-D04": 24, "D2B-FG-B04": 36, "D2B-FG-F03": 16, "D2B-FG-D03": 24, "D2B-FG-B03": 36, "D2B-FG-F02": 16, "D2B-FG-D02": 24, "D2B-FG-B02": 36, "D2B-FG-D01": 36, "D2B-FG-F01": 16, "D2B-FG-B01": 36, "D2B-FG-E12": 16, "D2B-FG-C12": 24, "D2B-FG-A12": 36, "D2B-FG-E11": 16, "D2B-FG-C11": 24, "D2B-FG-A11": 36, "D2B-FG-E10": 16, "D2B-FG-C10": 24, "D2B-FG-A10": 36, "D2B-FG-E09": 16, "D2B-FG-C09": 24, "D2B-FG-A09": 36, "D2B-FG-E08": 16, "D2B-FG-C08": 24, "D2B-FG-A08": 36, "D2B-FG-E07": 16, "D2B-FG-C07": 24, "D2B-FG-A07": 36, "D2B-FG-E06": 16, "D2B-FG-C06": 24, "D2B-FG-A06": 36, "D2B-FG-E05": 16, "D2B-FG-C05": 24, "D2B-FG-A05": 36, "D2B-FG-E04": 16, "D2B-FG-C04": 24, "D2B-FG-A04": 36, "D2B-FG-E03": 16, "D2B-FG-C03": 24, "D2B-FG-A03": 36, "D2B-FG-E02": 16, "D2B-FG-C02": 24, "D2B-FG-A02": 36, "D2B-FG-C01": 24, "D2B-FG-E01": 8, "D2B-FG-A01": 13, "D2B-FG-H01": 120};
const OV_B2_TOTAL_CAPACITY = 1901; // chỉ dùng làm mô tả/ghi chú — số thật hiển thị luôn cộng từ từng vị trí (có áp override)
const OV_B2_EXCLUDED = ['D2B-FG-H01'];

function ov2BOverview(counts){
  const locs = B2_LOCATORS.filter(l => !OV_B2_EXCLUDED.includes(l));
  const pallets = locs.reduce((s,l) => s + (counts.get(l)||0), 0);
  const capOf = l => whApplyCapOverride(l, B2_CAPACITY_MAP[l] || 0);
  const capacity = locs.reduce((s,l) => s + capOf(l), 0);
  const groups = ovClassifyBucket4(locs, capOf, counts);
  return {
    pallets,
    capacity,
    positions: locs.length,
    bucketMode: 4,
    buckets: groups.map(g => g.length),
    bucketLocators: groups,
    bucketTotal: locs.length,
    miniKpis: [
      { v: pallets, l: 'PALLET 2B-FLOOR (không tính H01)' },
      { v: capacity, l: 'TỔNG CAPACITY (không tính H01)' }
    ]
  };
}

function ovBuildLocatorCounts(){
  const map = new Map();
  if(!currentData) return map;
  getRawRows(currentData).forEach(r => {
    const loc = r[RAW_KEY_IDX.locator];
    if(!loc) return;
    map.set(loc, (map.get(loc)||0) + 1);
  });
  return map;
}

const OV_BUCKET_COLORS_3 = ['var(--muted-2)', 'var(--amber-bright)', 'var(--teal)'];
const OV_BUCKET_COLORS_4 = ['var(--muted-2)', 'var(--blue)', 'var(--amber-bright)', 'var(--red)'];
const OV_BUCKET_LABELS_3 = ['Trống', '1/2 pallet', 'Đầy 2/2'];
const OV_BUCKET_LABELS_4 = ['Trống', 'Thấp (<50%)', 'Vừa (50–79%)', 'Gần đầy/đầy (≥80%)'];
const OV_DIST_SUB_3 = 'Racking: trống, 1/2 pallet và đầy 2/2 (sức chứa 2 pallet/vị trí)';
const OV_DIST_SUB_4 = 'Trống, thấp, vừa và gần đầy/đầy theo capacity từng locator';
const OV_DIST_SUB_CUSTOM = 'Tuỳ chỉnh — trống, thấp, vừa và gần đầy/đầy theo capacity từng vị trí đã chọn';
// Lưu chi tiết locator theo từng nhóm (trống/thấp/vừa/gần đầy...) của lần render gần nhất mỗi kho —
// dùng để hiện popover khi hover vào cột màu / badge trong "Phân bố trạng thái vị trí".
const ovBucketDetailCache = {}; // { code: { labels: [...], bucketLocators: [[{locator,qty,capacity}],...] } }
function buildOvBucketTooltipHtml(code, bucketIdx){
  const cache = ovBucketDetailCache[code];
  if(!cache) return '<div class="cpt-empty">Không có dữ liệu</div>';
  const label = cache.labels[bucketIdx] || '';
  const items = (cache.bucketLocators[bucketIdx] || []).slice().sort((a,b) => a.locator.localeCompare(b.locator, 'vi', { numeric: true }));
  const khoTitle = `Kho ${code} — ${escHtml(label)}`;
  if(!items.length){
    return `<div class="cpt-item-head"><b>${khoTitle}</b></div><div class="cpt-empty">Không có vị trí nào trong nhóm này</div>`;
  }
  const rowsHtml = items.map(it => `<div class="cpt-loc-row"><span>${escHtml(it.locator)}</span><b>${fmt(it.qty)} / ${fmt(it.capacity)}</b></div>`).join('');
  return `<div class="cpt-item-head"><b>${khoTitle}</b></div>
    <div class="cpt-locs">${rowsHtml}</div>
    <div class="cpt-total">Tổng ${fmt(items.length)} vị trí</div>`;
}

function ovRenderPanel(code, ov, isCustom, ngPallets){
  const ringEl = document.getElementById('ov-ring-' + code);
  const utilEl = document.getElementById('ov-util-' + code);
  const palletsEl = document.getElementById('ov-pallets-' + code);
  const capacityEl = document.getElementById('ov-capacity-' + code);
  const positionsEl = document.getElementById('ov-positions-' + code);
  const headEl = document.getElementById('ov-head-summary-' + code);
  const tagEl = document.getElementById('ov-config-tag-' + code);
  const noteEl = document.getElementById('ov-formula-note-' + code);
  if(!ringEl) return;

  if(tagEl) tagEl.style.display = isCustom ? '' : 'none';
  if(noteEl) noteEl.textContent = isCustom ? 'Đang dùng danh sách vị trí TUỲ CHỈNH — bấm "Tuỳ chỉnh vị trí" (bánh răng) ở đầu mục này để xem/sửa lại.' : '';

  const util = ov.capacity ? (ov.pallets / ov.capacity) * 100 : 0;
  const utilClamped = Math.max(0, Math.min(100, util));
  const ngPct = ov.capacity ? Math.max(0, Math.min(utilClamped, ((ngPallets||0) / ov.capacity) * 100)) : 0;
  ringEl.style.setProperty('--pct', utilClamped.toFixed(1));
  ringEl.style.setProperty('--ng-pct', ngPct.toFixed(1));
  ringEl.style.setProperty('--ov-ring-color', util > 100 ? 'var(--red)' : util >= 90 ? 'var(--amber-bright)' : 'var(--teal)');
  const ngBadgeEl = document.getElementById('ov-ring-ng-badge-' + code);
  if(ngBadgeEl){
    if(ngPallets > 0){
      ngBadgeEl.style.display = '';
      ngBadgeEl.textContent = `NG ${ngPct.toFixed(1)}%`;
      ngBadgeEl.title = `${fmt(ngPallets)} pallet NG / ${fmt(ov.capacity)} tổng sức chứa`;
    } else {
      ngBadgeEl.style.display = 'none';
    }
  }
  if(utilEl) utilEl.textContent = util.toFixed(1) + '%';
  if(palletsEl) palletsEl.textContent = fmt(ov.miniKpis[0].v);
  if(capacityEl) capacityEl.textContent = fmt(ov.miniKpis[1].v);
  if(positionsEl) positionsEl.textContent = fmt(ov.positions);
  const palletsLabelEl = palletsEl ? palletsEl.parentElement.querySelector('.l') : null;
  const capacityLabelEl = capacityEl ? capacityEl.parentElement.querySelector('.l') : null;
  if(palletsLabelEl) palletsLabelEl.textContent = ov.miniKpis[0].l;
  if(capacityLabelEl) capacityLabelEl.textContent = ov.miniKpis[1].l;
  if(headEl){
    const tagHtml = tagEl ? tagEl.outerHTML : '';
    headEl.innerHTML = `<span><b>${util.toFixed(1)}%</b> utilization</span><span>${fmt(ov.pallets)} / ${fmt(ov.capacity)} pallet</span>${tagHtml}`;
  }

  const barEl = document.getElementById('ov-dist-bar-' + code);
  const badgesEl = document.getElementById('ov-dist-badges-' + code);
  const subEl = document.getElementById('ov-dist-sub-' + code);
  const colors = ov.bucketMode === 3 ? OV_BUCKET_COLORS_3 : OV_BUCKET_COLORS_4;
  const labels = ov.bucketMode === 3 ? OV_BUCKET_LABELS_3 : OV_BUCKET_LABELS_4;
  ovBucketDetailCache[code] = { labels, bucketLocators: ov.bucketLocators || [] };
  if(barEl){
    const total = ov.bucketTotal || 1;
    barEl.innerHTML = ov.buckets.map((v,i) => `<span data-kho="${code}" data-bucket="${i}" style="width:${(v/total*100)}%; background:${colors[i]}; cursor:pointer;"></span>`).join('');
  }
  if(badgesEl){
    badgesEl.innerHTML = ov.buckets.map((v,i) => `<div class="ov-dist-badge" data-kho="${code}" data-bucket="${i}"><i style="background:${colors[i]};"></i><b>${fmt(v)}</b>${escHtml(labels[i])}</div>`).join('');
  }
  if(subEl) subEl.textContent = isCustom ? OV_DIST_SUB_CUSTOM : (ov.bucketMode === 3 ? OV_DIST_SUB_3 : OV_DIST_SUB_4);

  const free = Math.max(0, ov.capacity - ov.pallets);
  const usedPct = ov.capacity ? Math.min(100, (ov.pallets / ov.capacity) * 100) : 0;
  const freePct = ov.capacity ? Math.min(100, (free / ov.capacity) * 100) : 0;
  const usedBar = document.getElementById('ov-cmp-used-bar-' + code);
  const freeBar = document.getElementById('ov-cmp-free-bar-' + code);
  if(usedBar) usedBar.style.height = Math.max(usedPct, 2) + '%';
  if(freeBar) freeBar.style.height = Math.max(freePct, 2) + '%';
  const usedVal = document.getElementById('ov-cmp-used-val-' + code);
  const freeVal = document.getElementById('ov-cmp-free-val-' + code);
  if(usedVal) usedVal.textContent = fmt(ov.pallets);
  if(freeVal) freeVal.textContent = fmt(free);
}

// Danh sách locator + sức chứa MẶC ĐỊNH do hệ thống tự tính cho từng kho (dùng làm điểm khởi đầu
// trong modal tuỳ chỉnh, và cho nút "Về mặc định").
function ovDefaultCapMap(kho){
  const map = {};
  if(kho === '3B'){
    ovB3FloorLocators().forEach(l => { map[l] = whApplyCapOverride(l, ovB3Capacity(l)); });
  } else if(kho === '3A'){
    ov3ARackLocators().forEach(l => { map[l] = whApplyCapOverride(l, OV_3A_RACK_CAPACITY_PER_LOC); });
    ov3AFloorLocators().forEach(l => { const c = ov3AFloorCapacity(l); if(c) map[l] = whApplyCapOverride(l, c); });
    ov3AM1Locators().forEach(l => { map[l] = whApplyCapOverride(l, OV_3A_M1_CAPACITY_PER_LOC); });
  } else if(kho === '2B'){
    B2_LOCATORS.filter(l => !OV_B2_EXCLUDED.includes(l)).forEach(l => { map[l] = whApplyCapOverride(l, B2_CAPACITY_MAP[l] || 0); });
  }
  return map;
}

// Tính Utilization/Capacity/phân bố từ 1 danh sách {locator: capacity} tuỳ chỉnh bất kỳ — dùng
// chung 1 công thức 4-nhóm (%) cho cả 3 kho khi đã tuỳ chỉnh, để đơn giản và nhất quán. Vẫn áp số
// ghi đè từ nút bánh răng (trang Sơ đồ kho) đè lên trên sức chứa đã lưu trong cấu hình tuỳ chỉnh,
// để 2 nơi luôn khớp — miễn locator đó vẫn đang có trong danh sách tuỳ chỉnh này.
function ovGenericOverview(cfg, counts){
  const capMap = cfg.locators || {};
  const locs = Object.keys(capMap);
  const capOf = l => whApplyCapOverride(l, Number(capMap[l]) || 0);
  const pallets = locs.reduce((s,l) => s + (counts.get(l)||0), 0);
  const autoCapacity = locs.reduce((s,l) => s + capOf(l), 0);
  const capacity = (cfg.totalOverride !== null && cfg.totalOverride !== undefined && cfg.totalOverride !== '')
    ? Number(cfg.totalOverride) : autoCapacity;
  const groups = ovClassifyBucket4(locs, capOf, counts);
  return {
    pallets, capacity, positions: locs.length, bucketMode: 4,
    buckets: groups.map(g => g.length), bucketLocators: groups, bucketTotal: locs.length,
    miniKpis: [
      { v: pallets, l: 'PALLET ĐANG CHỨA (TUỲ CHỈNH)' },
      { v: capacity, l: 'TỔNG SỨC CHỨA CHUẨN (TUỲ CHỈNH)' }
    ]
  };
}

function renderCapacityOverviews(){
  ovLoadConfigFromStorage();
  const counts = ovBuildLocatorCounts();
  const cfg = ovLocatorConfig || {};
  const cfg3B = ovMigrateCfgShape(cfg['3B']);
  const cfg3A = ovMigrateCfgShape(cfg['3A']);
  const cfg2B = ovMigrateCfgShape(cfg['2B']);
  const ov3B = cfg3B ? ovGenericOverview(cfg3B, counts) : ovB3Overview(counts);
  const ov3A = cfg3A ? ovGenericOverview(cfg3A, counts) : ov3AOverview(counts);
  const ov2B = cfg2B ? ovGenericOverview(cfg2B, counts) : ov2BOverview(counts);
  const ngSum3B = ovGetNgSummaryForKho('3B');
  const ngSum3A = ovGetNgSummaryForKho('3A');
  const ngSum2B = ovGetNgSummaryForKho('2B');
  ovRenderPanel('3B', ov3B, !!cfg3B, ngSum3B.totalNgPallets);
  ovRenderPanel('3A', ov3A, !!cfg3A, ngSum3A.totalNgPallets);
  ovRenderPanel('2B', ov2B, !!cfg2B, ngSum2B.totalNgPallets);
  ovRenderNgSection('3B', ov3B.pallets, ngSum3B);
  ovRenderNgSection('3A', ov3A.pallets, ngSum3A);
  ovRenderNgSection('2B', ov2B.pallets, ngSum2B);
  if(typeof renderUtilizationTrendChart === 'function') renderUtilizationTrendChart();
  if(typeof renderAlertsPanel === 'function') renderAlertsPanel();
}

// Danh sách mã hàng + locator đang có hàng NG trong 1 kho (gộp theo item+PO+locator).
function ovGetNgRowsForKho(khoLabel){
  const map = new Map();
  if(currentData){
    // Dùng dữ liệu GỐC theo từng dòng (1 dòng = 1 GI No. = 1 pallet), KHÔNG dùng kho_detail vì
    // kho_detail đã gộp sẵn theo item+custpo+locator+OQC nên luôn ra 1 pallet/dòng — sai với
    // thực tế (VD: 1 mã có thể nằm trên nhiều pallet/GI No. khác nhau cùng 1 locator).
    getRawRows(currentData).forEach(r => {
      const kho = r[RAW_KEY_IDX.kho];
      if(kho !== khoLabel) return;
      const item = r[RAW_KEY_IDX.item], custpo = r[RAW_KEY_IDX.custpo] || '', locator = r[RAW_KEY_IDX.locator];
      const oqc = String(r[RAW_KEY_IDX.oqc] || '').toUpperCase(), qty = Number(r[RAW_KEY_IDX.qty]) || 0;
      if(!item || !locator) return;
      if(!oqc.includes('NG')) return;
      const key = item + '||' + custpo + '||' + locator;
      if(!map.has(key)) map.set(key, { item, custpo, locator, qty: 0, pallets: 0 });
      const entry = map.get(key);
      entry.qty += qty;
      entry.pallets += 1; // mỗi dòng dữ liệu gốc (GI No.) = 1 pallet, khớp quy ước tính Utilization
    });
  }
  return Array.from(map.values()).sort((a,b) => b.qty - a.qty);
}

function ovGetNgSummaryForKho(code){
  const rows = ovGetNgRowsForKho(OV_KHO_LABELS[code]);
  const totalNgQty = rows.reduce((s,r) => s + r.qty, 0);
  const totalNgPallets = rows.reduce((s,r) => s + r.pallets, 0);
  return { rows, totalNgQty, totalNgPallets };
}

function ovRenderNgSection(code, usedPallets, ngSummary){
  const listEl = document.getElementById('ov-ng-list-' + code);
  const summaryEl = document.getElementById('ov-ng-summary-' + code);
  if(!listEl) return;
  const { rows, totalNgQty, totalNgPallets } = ngSummary || ovGetNgSummaryForKho(code);

  // Tính trước mã nào có trong Plan (dùng chung cho cả dòng tóm tắt lẫn danh sách chi tiết)
  const rowsWithPlan = rows.map(r => ({
    ...r,
    hasPlan: typeof buildItemContainerList === 'function' && buildItemContainerList(r.item, r.custpo).length > 0
  }));
  const distinctCodes = new Set(rows.map(r => r.item + '||' + r.custpo));
  const distinctCodesWithPlan = new Set(rowsWithPlan.filter(r => r.hasPlan).map(r => r.item + '||' + r.custpo));
  const pctOfUsed = usedPallets ? (totalNgPallets / usedPallets * 100) : 0;

  if(summaryEl){
    summaryEl.innerHTML = !rows.length
      ? 'Không có hàng NG trong kho này'
      : `<b>${fmt(distinctCodes.size)}</b> mã + PO đang NG (${fmt(rows.length)} dòng vị trí) · <b>${fmt(totalNgQty)} Pcs</b> — <b>${fmt(totalNgPallets)} pallet</b> (chiếm <b>${pctOfUsed.toFixed(1)}%</b> pallet đang dùng)` +
        (distinctCodesWithPlan.size ? ` · <span class="warn">⚠ ${fmt(distinctCodesWithPlan.size)} mã có trong Plan xuất cont</span>` : '');
  }

  if(!rows.length){
    listEl.innerHTML = '<div class="cpt-empty" style="padding:6px 0;">Không có hàng NG trong kho này</div>';
    return;
  }
  const khoLabel = OV_KHO_LABELS[code] || '';
  listEl.innerHTML = rowsWithPlan.map(r => {
    const badge = r.hasPlan
      ? `<button type="button" class="ov-ng-plan-badge item-link" data-item="${escAttr(r.item)}" data-po="${escAttr(r.custpo)}" data-jump-combined="${escAttr(combinedRowDomId(r.item, r.custpo))}" title="Mã + PO này đang nằm trong kế hoạch xuất cont — di chuột xem container, bấm để xem trong Tổng hợp 3 Plan">⚠ Có trong Plan</button>`
      : '';
    return `<div class="ov-ng-row" data-jump-search data-item="${escAttr(r.item)}" data-po="${escAttr(r.custpo)}" data-locator="${escAttr(r.locator)}" data-kho-label="${escAttr(khoLabel)}" title="Bấm để xem mã này trong bảng tìm kiếm (Tổng hợp + Dữ liệu gốc theo dòng)">
      <span class="ov-ng-item" title="${escAttr(r.item)}${r.custpo ? ' (PO ' + r.custpo + ')' : ''}">${escHtml(r.item)}${r.custpo ? ` <span class="ov-ng-po">(PO ${escHtml(r.custpo)})</span>` : ''}</span>
      <span class="ov-ng-loc" title="${escAttr(r.locator)}">${escHtml(r.locator)}</span>
      <span class="ov-ng-qty">${fmt(r.qty)} Pcs <span class="ov-ng-pallet">(${fmt(r.pallets)} pallet)</span></span>
      ${badge}
    </div>`;
  }).join('');
}

/* ---------- Modal "Tuỳ chỉnh vị trí tính Utilization" ---------- */
const OV_CONFIG_STORAGE_KEY = 'tn5_ov_locator_config_v1';
let ovLocatorConfig = {}; // { '3B': {locator:capacity}, '3A': {...}, '2B': {...} } — có key = kho đó đang tuỳ chỉnh
function ovLoadConfigFromStorage(){
  try{
    const raw = LS.getItem(OV_CONFIG_STORAGE_KEY);
    ovLocatorConfig = raw ? JSON.parse(raw) : {};
  }catch(e){ ovLocatorConfig = {}; }
}
// Tương thích ngược: bản lưu cũ (trước khi có "Tổng sức chứa ghi đè") chỉ là {locator:capacity}
// phẳng, không có key "locators" bọc ngoài — tự bọc lại cho đúng cấu trúc mới.
function ovMigrateCfgShape(saved){
  if(!saved) return null;
  if(saved.locators) return saved;
  return { locators: saved, totalOverride: null };
}

const OV_KHO_LABELS = { '3B': 'Kho 3B', '3A': 'Kho 3A', '2B': 'Kho 2B' };
let ovConfigDraft = null; // bản nháp đang sửa trong modal, chưa lưu — { '3B': {locators:{loc:cap}, totalOverride:null|number}, ... }
let ovConfigActiveTab = '3B';

function ovSumCapacities(locators){
  return Object.keys(locators).reduce((s,l) => s + (Number(locators[l]) || 0), 0);
}

// Danh sách locator THẬT SỰ có trong dữ liệu tồn kho đang tải, thuộc 1 kho — giúp phát hiện các
// locator mà công thức tự động chưa liệt kê (VD: sai tiền tố), để người dùng có thể tự thêm vào.
function ovGetRealLocatorsForKho(khoLabel){
  const set = new Set();
  if(currentData && currentData.kho_detail && currentData.kho_detail[khoLabel]){
    currentData.kho_detail[khoLabel].forEach(r => { if(r[2]) set.add(r[2]); });
  }
  return set;
}

function ovUpdateConfigCount(){
  const countEl = document.getElementById('ov-config-count');
  if(!countEl || !ovConfigDraft) return;
  const selected = Object.keys(ovConfigDraft[ovConfigActiveTab].locators).length;
  const total = document.querySelectorAll('#ov-config-list .ov-config-row').length;
  countEl.textContent = `${fmt(selected)} / ${fmt(total)} đã chọn (đang lọc)`;
}

// Cập nhật dòng "Tổng sức chứa chuẩn" (ô ghi đè + số tự động tính) theo trạng thái draft hiện tại.
function ovUpdateTotalRow(){
  if(!ovConfigDraft) return;
  const cfg = ovConfigDraft[ovConfigActiveTab];
  const autoTotal = ovSumCapacities(cfg.locators);
  const inputEl = document.getElementById('ov-config-total-input');
  const autoEl = document.getElementById('ov-config-total-auto');
  if(autoEl) autoEl.textContent = `Tự động (cộng các vị trí đã chọn): ${fmt(autoTotal)}`;
  if(inputEl) inputEl.value = (cfg.totalOverride !== null && cfg.totalOverride !== undefined) ? cfg.totalOverride : '';
}

function ovRenderConfigList(){
  const listEl = document.getElementById('ov-config-list');
  if(!listEl || !ovConfigDraft) return;
  const kho = ovConfigActiveTab;
  const draft = ovConfigDraft[kho].locators;
  const counts = ovBuildLocatorCounts();
  const defaultMap = ovDefaultCapMap(kho);
  const defaultCandidates = new Set(Object.keys(defaultMap));
  const realLocs = ovGetRealLocatorsForKho(OV_KHO_LABELS[kho]);
  const allLocs = new Set([...defaultCandidates, ...realLocs, ...Object.keys(draft)]);
  const sorted = Array.from(allLocs).sort((a,b) => a.localeCompare(b, 'vi', { numeric: true }));

  const searchEl = document.getElementById('ov-config-search');
  const q = searchEl ? removeDiacritics(searchEl.value.toLowerCase().trim()) : '';
  const filtered = q ? sorted.filter(l => removeDiacritics(l.toLowerCase()).includes(q)) : sorted;

  listEl.innerHTML = filtered.map(loc => {
    const checked = Object.prototype.hasOwnProperty.call(draft, loc);
    const isExtra = !defaultCandidates.has(loc);
    const qty = counts.get(loc) || 0;
    const cap = checked ? draft[loc] : (defaultMap[loc] || 0);
    return `<div class="ov-config-row${isExtra ? ' extra' : ''}" data-loc="${escAttr(loc)}">
      <input type="checkbox" class="ov-cfg-chk" ${checked ? 'checked' : ''}>
      <span class="loc-name" title="${escAttr(loc)}">${escHtml(loc)}${isExtra ? ' <span style="color:var(--amber-bright); font-size:10px;">(ngoài DS mặc định)</span>' : ''}</span>
      <span class="loc-qty">${fmt(qty)}</span>
      <input type="number" class="cap-input" value="${cap}" min="0">
    </div>`;
  }).join('') || '<div style="padding:16px; text-align:center; color:var(--muted-2); font-style:italic;">Không có locator nào khớp tìm kiếm</div>';

  document.querySelectorAll('.ov-config-tab').forEach(t => t.classList.toggle('active', t.dataset.kho === kho));
  ovUpdateConfigCount();
  ovUpdateTotalRow();
}

function ovOpenConfigModal(){
  ovLoadConfigFromStorage();
  ovConfigDraft = {};
  ['3B', '3A', '2B'].forEach(k => {
    const saved = ovMigrateCfgShape(ovLocatorConfig[k]);
    if(saved){
      // Áp số ghi đè từ nút bánh răng (trang Sơ đồ kho) lên các locator đã lưu trong cấu hình
      // tuỳ chỉnh này, để modal luôn hiện đúng giá trị MỚI NHẤT, dù được sửa ở đâu trước đó.
      const locators = {};
      Object.keys(saved.locators).forEach(l => { locators[l] = whApplyCapOverride(l, saved.locators[l]); });
      ovConfigDraft[k] = { locators, totalOverride: (saved.totalOverride ?? null) };
    } else {
      ovConfigDraft[k] = { locators: ovDefaultCapMap(k), totalOverride: null };
    }
  });
  ovConfigActiveTab = '3B';
  const searchEl = document.getElementById('ov-config-search');
  if(searchEl) searchEl.value = '';
  const modal = document.getElementById('ov-config-modal');
  if(modal) modal.style.display = 'flex';
  ovRenderConfigList();
}
function ovCloseConfigModal(){
  const modal = document.getElementById('ov-config-modal');
  if(modal) modal.style.display = 'none';
  ovConfigDraft = null;
}

const ovConfigBtn = document.getElementById('btn-ov-config');
if(ovConfigBtn) ovConfigBtn.addEventListener('click', ovOpenConfigModal);
const ovConfigCloseBtn = document.getElementById('ov-config-close');
if(ovConfigCloseBtn) ovConfigCloseBtn.addEventListener('click', ovCloseConfigModal);
const ovConfigCancelBtn = document.getElementById('ov-config-cancel');
if(ovConfigCancelBtn) ovConfigCancelBtn.addEventListener('click', ovCloseConfigModal);
const ovConfigBackdrop = document.getElementById('ov-config-backdrop');
if(ovConfigBackdrop) ovConfigBackdrop.addEventListener('click', ovCloseConfigModal);

document.addEventListener('click', (e) => {
  const tab = e.target.closest('.ov-config-tab');
  if(tab){
    ovConfigActiveTab = tab.dataset.kho;
    const searchEl = document.getElementById('ov-config-search');
    if(searchEl) searchEl.value = '';
    ovRenderConfigList();
  }
});
const ovConfigSearchEl = document.getElementById('ov-config-search');
if(ovConfigSearchEl) ovConfigSearchEl.addEventListener('input', debounce(() => ovRenderConfigList(), 150));

document.addEventListener('change', (e) => {
  const row = e.target.closest('.ov-config-row');
  if(row && ovConfigDraft){
    const loc = row.dataset.loc;
    const draft = ovConfigDraft[ovConfigActiveTab].locators;
    const capInput = row.querySelector('.cap-input');
    if(e.target.classList.contains('ov-cfg-chk')){
      if(e.target.checked) draft[loc] = Number(capInput ? capInput.value : 0) || 0;
      else delete draft[loc];
      ovUpdateConfigCount();
      ovUpdateTotalRow();
    } else if(e.target.classList.contains('cap-input')){
      if(Object.prototype.hasOwnProperty.call(draft, loc)) draft[loc] = Number(e.target.value) || 0;
      ovUpdateTotalRow();
    }
    return;
  }
  if(e.target.id === 'ov-config-total-input' && ovConfigDraft){
    const v = e.target.value.trim();
    ovConfigDraft[ovConfigActiveTab].totalOverride = v === '' ? null : Number(v);
  }
});

const ovConfigSelAllBtn = document.getElementById('ov-config-selall');
if(ovConfigSelAllBtn) ovConfigSelAllBtn.addEventListener('click', () => {
  if(!ovConfigDraft) return;
  document.querySelectorAll('#ov-config-list .ov-config-row').forEach(row => {
    const chk = row.querySelector('.ov-cfg-chk');
    const capInput = row.querySelector('.cap-input');
    if(chk) chk.checked = true;
    ovConfigDraft[ovConfigActiveTab].locators[row.dataset.loc] = Number(capInput ? capInput.value : 0) || 0;
  });
  ovUpdateConfigCount();
  ovUpdateTotalRow();
});
const ovConfigClrAllBtn = document.getElementById('ov-config-clrall');
if(ovConfigClrAllBtn) ovConfigClrAllBtn.addEventListener('click', () => {
  if(!ovConfigDraft) return;
  document.querySelectorAll('#ov-config-list .ov-config-row').forEach(row => {
    const chk = row.querySelector('.ov-cfg-chk');
    if(chk) chk.checked = false;
    delete ovConfigDraft[ovConfigActiveTab].locators[row.dataset.loc];
  });
  ovUpdateConfigCount();
  ovUpdateTotalRow();
});
const ovConfigResetBtn = document.getElementById('ov-config-resetdefault');
if(ovConfigResetBtn) ovConfigResetBtn.addEventListener('click', () => {
  if(!ovConfigDraft) return;
  ovConfigDraft[ovConfigActiveTab] = { locators: ovDefaultCapMap(ovConfigActiveTab), totalOverride: null };
  ovRenderConfigList();
});
const ovConfigTotalClearBtn = document.getElementById('ov-config-total-clear');
if(ovConfigTotalClearBtn) ovConfigTotalClearBtn.addEventListener('click', () => {
  if(!ovConfigDraft) return;
  ovConfigDraft[ovConfigActiveTab].totalOverride = null;
  ovUpdateTotalRow();
});
const ovConfigSaveBtn = document.getElementById('ov-config-save');
if(ovConfigSaveBtn) ovConfigSaveBtn.addEventListener('click', () => {
  if(!ovConfigDraft) return;
  ovLocatorConfig = {};
  // Ghi ngược sức chứa từng locator vừa sửa trong modal này vào kho lưu CHUNG (whCapOverrides) —
  // để trang "Sơ đồ kho" (nút bánh răng) cũng thấy đúng số mới nhất, bất kể sửa ở đâu trước đó.
  const whOverrides = (typeof whLoadCapOverrides === 'function') ? whLoadCapOverrides() : {};
  ['3B', '3A', '2B'].forEach(k => {
    ovLocatorConfig[k] = { locators: { ...ovConfigDraft[k].locators }, totalOverride: ovConfigDraft[k].totalOverride };
    Object.keys(ovConfigDraft[k].locators).forEach(l => { whOverrides[l] = ovConfigDraft[k].locators[l]; });
  });
  LS.setItem(OV_CONFIG_STORAGE_KEY, JSON.stringify(ovLocatorConfig));
  if(typeof whSaveCapOverrides === 'function') whSaveCapOverrides(whOverrides);
  ovCloseConfigModal();
  renderCapacityOverviews();
  if(typeof renderSodo3B === 'function') renderSodo3B();
});

function renderDashboard(DATA){
  currentData = DATA;
  ccCaptureInventorySnapshot(DATA); // ghi snapshot tồn kho hôm nay -> dùng tính "SL tồn bất thường"
  const elSnapshot = document.getElementById('snapshot-date');
  if(elSnapshot) elSnapshot.textContent = DATA.snapshot_date;
  const elSub = document.getElementById('sub-line');
  if(elSub) elSub.textContent =
    `${fmt(DATA.n_rows)} dòng dữ liệu gốc · ${DATA.distinct_items} mã hàng · ${DATA.distinct_locators} vị trí kho · ${DATA.distinct_pallets} pallet`;
  const elFootLeft = document.getElementById('foot-left');
  if(elFootLeft) elFootLeft.textContent =
    `Tổng SL tồn ${fmt(DATA.total_qty)} · PASS ${pct(DATA.pass_qty, DATA.total_qty)} · NG ${pct(DATA.ng_qty, DATA.total_qty)}`;

  // (KPI tổng tồn kho/mã hàng/vị trí đã được thay bằng bảng "Số cont mỗi kho phải đóng" —
  // xem renderContainerPickingOverview(), phần cập nhật #kpi-strip.)

  const whMap = document.getElementById('wh-map');
  if(whMap){
    const khoColors = {'Kho 2B':'#2C6FCB','Kho 3A':'#6E4FE0','Kho 3B':'#0E8F76','Kho DG1':'#B76E00','Chua phan loai':'#8A97AC'};
    const palletByKho = DATA.pallet_by_kho || {};
    const khoOqcPallet = DATA.kho_oqc_pallet || {};
    const maxQty = Math.max(...DATA.kho_order.map(k=>palletByKho[k] || 0));
    whMap.innerHTML = DATA.kho_order.map(k=>{
      const q = palletByKho[k] || 0;
      const oqc = khoOqcPallet[k] || {};
      const ng = oqc.NG || 0;
      const heightPct = 24 + (maxQty ? (q/maxQty)*76 : 0);
      const ngPct = q ? (ng/q*100).toFixed(1) : '0.0';
      const ngHeightPx = q ? Math.max(2, (ng/q)*100) : 0;
      const color = khoColors[k] || '#8A97AC';
      return `<div class="wh-block">
          <div class="wh-bar-track">
            <div class="wh-qty">${fmt(q)}</div>
            <div class="wh-bar" style="height:${heightPct}%; background:${color}33; border-top:2px solid ${color};">
              <div class="ng-slice" style="height:${ngHeightPx}%;"></div>
            </div>
          </div>
          <div class="wh-name">${k.replace('Kho ','')}</div>
          <div class="wh-pct">NG ${ngPct}%</div>
        </div>`;
    }).join('');
  }

  const oqcWrap = document.getElementById('oqc-bar-wrap');
  if(oqcWrap){
    const passPct = DATA.total_qty ? (DATA.pass_qty / DATA.total_qty * 100) : 0;
    const ngPct2 = DATA.total_qty ? (DATA.ng_qty / DATA.total_qty * 100) : 0;
    oqcWrap.innerHTML = `
      <div class="oqc-bar-outer">
        <div class="oqc-bar-seg pass" style="width:${passPct}%">${passPct>=10?passPct.toFixed(1)+'%':''}</div>
        <div class="oqc-bar-seg ng" style="width:${ngPct2}%">${ngPct2>=10?ngPct2.toFixed(1)+'%':''}</div>
      </div>
      <div class="oqc-legend-row">
        <span class="item"><i class="sw2" style="background:var(--teal)"></i>PASS <b>${fmt(DATA.pass_qty)}</b> (${passPct.toFixed(1)}%)</span>
        <span class="item"><i class="sw2" style="background:var(--red)"></i>NG <b>${fmt(DATA.ng_qty)}</b> (${ngPct2.toFixed(1)}%)</span>
      </div>`;
  }

  // Panel 3B
  const watchRow3b = document.getElementById('watch-locator-row-3b');
  const watchTbody3b = document.getElementById('watch-locator-tbody-3b');
  const watchBadge3b = document.getElementById('watch-pallet-total-3b');
  const watchList3b = DATA.locator_watch_3b || [];
  if(watchRow3b && watchTbody3b){
    if(!watchList3b.length){
      watchRow3b.style.display = 'none';
    } else {
      watchRow3b.style.display = '';
      watchTbody3b.innerHTML = watchList3b.map(r => `
        <tr>
          <td>${r.item}</td>
          <td><span class="tag-kho">${r.locator}</span></td>
          <td class="num">${fmt(r.qty)}</td>
          <td>${giCellHtml(r.gi)}</td>
          <td>${r.lot || '—'}</td>
          <td>${r.pallet || '—'}</td>
        </tr>`).join('');
      if(watchBadge3b){
        const palletCount3b = watchList3b.filter(r => r.pallet !== undefined && r.pallet !== null && String(r.pallet).trim() !== '').length;
        watchBadge3b.textContent = `${fmt(palletCount3b)} pallet`;
      }
    }
  }

  // Panel 3A
  const watchRow3a = document.getElementById('watch-locator-row-3a');
  const watchTbody3a = document.getElementById('watch-locator-tbody-3a');
  const watchBadge3a = document.getElementById('watch-pallet-total-3a');
  const watchList3a = DATA.locator_watch_3a || [];
  if(watchRow3a && watchTbody3a){
    if(!watchList3a.length){
      watchRow3a.style.display = 'none';
    } else {
      watchRow3a.style.display = '';
      watchTbody3a.innerHTML = watchList3a.map(r => `
        <tr>
          <td>${r.item}</td>
          <td><span class="tag-kho">${r.locator}</span></td>
          <td class="num">${fmt(r.qty)}</td>
          <td>${giCellHtml(r.gi)}</td>
          <td>${r.lot || '—'}</td>
          <td>${r.pallet || '—'}</td>
        </tr>`).join('');
      if(watchBadge3a){
        const palletCount3a = watchList3a.filter(r => r.pallet !== undefined && r.pallet !== null && String(r.pallet).trim() !== '').length;
        watchBadge3a.textContent = `${fmt(palletCount3a)} pallet`;
      }
    }
  }

  if(typeof renderPlanPanel === 'function') renderPlanPanel();
  if(typeof renderCapacityOverviews === 'function') renderCapacityOverviews();
  // KHÔNG tự gọi touchUpdatedAt() ở đây — hàm renderDashboard() này được gọi ở NHIỀU nơi không phải
  // là thời điểm người dùng vừa tải file mới lên (VD: khôi phục dữ liệu đã lưu lúc mở lại trang, tải
  // lại từ Cloud, đồng bộ realtime...). Trước đây gọi vô điều kiện ở đây khiến dòng "Cập nhật lúc"
  // luôn bị ghi đè thành THỜI ĐIỂM VỪA RENDER (VD: lúc mở lại app) thay vì đúng thời điểm file dữ
  // liệu THỰC SỰ được tải lên — dòng "Cập nhật lúc" hiện sai be bét dù đã khôi phục đúng giá trị đã
  // lưu ngay trước khi gọi hàm này. Giờ chỉ nơi nào THỰC SỰ vừa xử lý xong 1 file mới (tìm
  // touchUpdatedAt(file.name) ở nơi gọi renderDashboard()) mới được cập nhật dòng này.
}

const btnUpdate = document.getElementById('sidebar-logo-update');
const fileInput = document.getElementById('file-input');
const statusEl = document.getElementById('upload-status');
const overlay = document.getElementById('loading-overlay');
const loadingMsg = document.getElementById('loading-msg');

// ============ THƯ VIỆN GIAO DIỆN (theme library) ============
// Mặc định vẫn là Sáng/Tối như trước giờ — bấm nút này giờ mở 1 bảng chọn thay vì đổi
// thẳng Sáng↔Tối. Thêm giao diện mới sau này: thêm 1 khối CSS body[data-theme="<id>"]
// (xem "cyberpunk" trong <style> làm ví dụ) rồi thêm đúng 1 dòng vào mảng bên dưới —
// bảng chọn + toàn bộ logic tự nhận diện, không phải sửa gì khác.
const THEME_LIBRARY = [
  { id: 'light', label: 'Sáng', swatch: '#B76E00' }, // mặc định — không gắn data-theme
  { id: 'dark', label: 'Tối', swatch: '#F5A623' },
  { id: 'cyberpunk', label: 'Cyberpunk', swatch: '#3FE1FF' }
];

function tn5ValidThemeId(id){
  return THEME_LIBRARY.some(t => t.id === id) ? id : 'light';
}

// Áp dụng 1 giao diện: gắn/gỡ data-theme, cập nhật icon + chấm màu trên nút, đánh dấu
// đúng dòng đang chọn trong bảng, và (mặc định) lưu lại lựa chọn.
function tn5ApplyTheme(id, opts){
  opts = opts || {};
  const themeId = tn5ValidThemeId(id);
  if(themeId === 'light') document.body.removeAttribute('data-theme');
  else document.body.setAttribute('data-theme', themeId);

  const iconSun = document.getElementById('theme-icon-sun');
  const iconMoon = document.getElementById('theme-icon-moon');
  const iconCustom = document.getElementById('theme-icon-custom');
  const badge = document.getElementById('theme-badge');
  const themeBtn = document.getElementById('theme-toggle-btn');
  const theme = THEME_LIBRARY.find(t => t.id === themeId);
  if(iconSun) iconSun.style.display = themeId === 'light' ? '' : 'none';
  if(iconMoon) iconMoon.style.display = themeId === 'dark' ? '' : 'none';
  if(iconCustom) iconCustom.style.display = (themeId !== 'light' && themeId !== 'dark') ? '' : 'none';
  if(badge){
    badge.style.display = themeId === 'light' ? 'none' : '';
    if(theme) badge.style.background = theme.swatch;
  }
  if(themeBtn) themeBtn.title = 'Giao diện: ' + (theme ? theme.label : themeId) + ' — bấm để đổi';

  document.querySelectorAll('#theme-panel-list .theme-option').forEach(el => {
    el.classList.toggle('active', el.dataset.themeId === themeId);
  });

  if(opts.persist !== false){
    try{ LS.setItem('tn5_theme', themeId); }catch(e){}
    try{ localStorage.setItem('tn5_theme', themeId); }catch(e){} // chỉ để tránh nháy giao diện khi mở lại trang
  }
}

function tn5RenderThemePanelList(){
  const list = document.getElementById('theme-panel-list');
  if(!list) return;
  const current = tn5ValidThemeId(document.body.getAttribute('data-theme') || 'light');
  list.innerHTML = THEME_LIBRARY.map(t => `
    <button type="button" class="theme-option${t.id === current ? ' active' : ''}" data-theme-id="${t.id}">
      <span class="theme-option-swatch" style="background:${t.swatch};"></span>
      ${t.label}
      <svg class="theme-option-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
    </button>`).join('');
}

(function initThemePicker(){
  const themeBtn = document.getElementById('theme-toggle-btn');
  const panel = document.getElementById('theme-panel');
  if(!themeBtn || !panel) return;

  tn5RenderThemePanelList();
  tn5ApplyTheme(document.body.getAttribute('data-theme') || 'light', { persist: false });

  document.addEventListener('click', (e) => {
    const opt = e.target.closest('.theme-option');
    if(opt){
      tn5ApplyTheme(opt.dataset.themeId);
      panel.style.display = 'none';
      return;
    }
    if(e.target.closest('#theme-toggle-btn')){
      panel.style.display = panel.style.display === 'none' ? 'flex' : 'none';
      return;
    }
    if(panel.style.display !== 'none' && !e.target.closest('#theme-panel') && !e.target.closest('#theme-toggle-btn')){
      panel.style.display = 'none';
    }
  });
})();

if(btnUpdate) btnUpdate.addEventListener('click', () => fileInput.click());
if(btnUpdate) btnUpdate.addEventListener('keydown', (e) => { if(e.key === 'Enter' || e.key === ' '){ e.preventDefault(); fileInput.click(); } });

if(fileInput){
  fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if(!file) return;
    if(overlay) overlay.classList.add('show');
    if(loadingMsg) loadingMsg.textContent = `Đang đọc "${file.name}"…`;
    if(statusEl){ statusEl.className = 'upload-status'; statusEl.textContent = 'Đang xử lý…'; }
    touchUpdatedAt(file.name);

    const ext = (file.name.split('.').pop() || '').toLowerCase();
    const isDelimited = ['csv','tsv','txt'].includes(ext);

    const reader = new FileReader();
    reader.onload = (ev) => {
      try{
        let name, rows;
        if(isDelimited){
          const text = decodeTextBuffer(ev.target.result);
          const delim = ext === 'tsv' ? '\t' : (ext === 'csv' ? ',' : guessDelimiter(text));
          rows = parseDelimitedText(text, delim);
          name = file.name;
        } else {
          if(!LIB_XLSX_OK) throw new Error('Thư viện đọc Excel (SheetJS) chưa tải được — cần Internet. Hãy mở file này bằng Chrome có mạng, hoặc lưu dữ liệu dạng .csv/.tsv rồi tải lên (không cần thư viện này).');
          const wb = XLSX.read(ev.target.result, {type:'array', cellDates:false});
          ({name, rows} = extractRawRows(wb));
        }
        const DATA = computeAggregates(rows);
        renderDashboard(DATA);
        touchUpdatedAt(file.name);
        currentFileName = file.name;
        _localInventoryDirty = true;
        saveStateToStorage();
        // Đẩy ngay lên Cloud sau 2 giây (giống hệt cơ chế đã dùng cho Ship ở tab Transaction) — để các
        // máy/người khác đang mở dashboard cũng thấy đúng dữ liệu tồn kho mới nhất, không cần đợi bấm
        // "Lưu" ở đầu trang. Kèm STORAGE_KEY_META (tên file/"cập nhật lúc") để tên file hiển thị đúng
        // trên các máy khác luôn, không lệch với dữ liệu tồn kho vừa cập nhật.
        scheduleAutoSaveToCloud('inventory', [STORAGE_KEY_INVENTORY, STORAGE_KEY_META], 'Dữ liệu tồn kho vừa tải');
        renderKhoSearchPage();
        // Vẽ lại các danh sách "Đề xuất kiểm hôm nay" đã tạo trước đó (nếu có) — tránh trường hợp
        // các khối kết quả (Kho 2B/3A/3B) bị mất khỏi màn hình sau khi cập nhật dữ liệu tồn kho mới,
        // dù dữ liệu ccKhoResults vẫn còn nguyên trong bộ nhớ.
        if(Object.keys(ccKhoResults).length) ccRestoreResultsFromStorage(ccKhoResults);
        const footRight = document.getElementById('foot-right');
        if(footRight) footRight.textContent = `Nguồn: "${name}" trong file "${file.name}" · Kho phân loại theo Locator Name (3A/3B/2B/DG1)`;
        if(statusEl){ statusEl.className = 'upload-status ok'; statusEl.textContent = `✓ Đã cập nhật từ "${file.name}" (${DATA.n_rows} dòng)`; }
      }catch(err){
        console.error('Lỗi khi xử lý file tồn kho:', err);
        touchUpdatedAt(file.name + ' (lỗi)');
        if(statusEl){ statusEl.className = 'upload-status err'; statusEl.textContent = `✗ Lỗi: ${err.message}`; }
      }finally{
        if(overlay) overlay.classList.remove('show');
        fileInput.value = '';
      }
    };
    reader.onerror = () => {
      if(overlay) overlay.classList.remove('show');
      if(statusEl){ statusEl.className = 'upload-status err'; statusEl.textContent = '✗ Không đọc được file.'; }
    };
    reader.readAsArrayBuffer(file);
  });
}

const PLAN_TYPES = ['Row', 'FC', 'HCP'];
const PLAN_COLORS = { Row: '#2C6FCB', FC: '#6E4FE0', HCP: '#B76E00' };
// Các loại Plan (Row/FC/HCP) đang ở chế độ "Sửa" (chỉnh sửa trực tiếp bảng chi tiết) — xem
// renderPlanPanel()/buildPlanEditRowHtml() bên dưới. Không lưu qua Storage/Cloud (chỉ là trạng thái
// UI tạm thời khi đang thao tác trên máy).
const planEditingTypes = new Set();
let planData = { Row: null, FC: null, HCP: null };

const PLAN_ITEM_CANDS = ['item no', 'item number', 'item', 'ma hang', 'ma hh', 'sku', 'part no', 'part number', 'material', 'tti model', 'model'];
const PLAN_QTY_CANDS  = ['qty (pcs)', 'qty(pcs)', 'total qty', 'qty', 'quantity', 'so luong xuat', 'sl xuat', 'planned qty', 'plan qty', 'so luong', 'sl', 'onhand qty', 'onhand'];

function locatePlanHeaderRow(rows){
  const maxScan = Math.min(rows.length, 20);
  for(let i=0;i<maxScan;i++){
    const row = rows[i];
    if(!row) continue;
    if(findCol(row, PLAN_ITEM_CANDS) !== -1 && findCol(row, PLAN_QTY_CANDS) !== -1) return i;
  }
  return 0;
}

function extractPlanSheetRows(workbook){
  let sheetName = workbook.SheetNames.find(n => n.trim().toLowerCase() === 'loading plan');
  if(sheetName){
    return { name: sheetName, rows: XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], {header:1, raw:true, defval:null}) };
  }
  const candidates = [];
  for(const name of workbook.SheetNames){
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[name], {header:1, raw:true, defval:null});
    if(!rows.length) continue;
    const hIdx = locatePlanHeaderRow(rows);
    const headerRow = rows[hIdx];
    if(findCol(headerRow, PLAN_ITEM_CANDS) === -1 || findCol(headerRow, PLAN_QTY_CANDS) === -1) continue;
    candidates.push({name, rows, hIdx, headerRow});
  }
  if(!candidates.length){
    return { name: workbook.SheetNames[0], rows: XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], {header:1, raw:true, defval:null}) };
  }
  if(candidates.length === 1) return { name: candidates[0].name, rows: candidates[0].rows };

  // Khi workbook có NHIỀU sheet hợp lệ (VD: nhiều bản kế hoạch load theo từng ngày khác nhau
  // gộp chung 1 file), ưu tiên chọn sheet có NGÀY LOAD (loading date) MỚI NHẤT — vì đó mới là
  // kế hoạch hiện hành người dùng cần xem, thay vì chọn đại theo sheet có nhiều dòng nhất
  // (dễ lấy nhầm sheet cũ chỉ vì nó có nhiều dòng trống/dữ liệu tồn đọng hơn).
  const colDateCands = ['loading date', 'ngay xuat', 'etd', 'ship date', 'ngay', 'date'];
  let bestByDate = null, bestDate = null;
  for(const c of candidates){
    const colDate = findCol(c.headerRow, colDateCands);
    if(colDate === -1) continue;
    let maxDate = null;
    for(let i = c.hIdx + 1; i < c.rows.length; i++){
      const row = c.rows[i];
      const d = row ? parseDateCell(row[colDate]) : null;
      if(d && (!maxDate || d > maxDate)) maxDate = d;
    }
    if(maxDate && (!bestDate || maxDate > bestDate)){ bestDate = maxDate; bestByDate = c; }
  }
  if(bestByDate) return { name: bestByDate.name, rows: bestByDate.rows };

  // Không sheet nào đọc được ngày — fallback như cũ: chọn sheet có nhiều dòng dữ liệu nhất
  let best = candidates[0];
  for(const c of candidates){ if(c.rows.length > best.rows.length) best = c; }
  return { name: best.name, rows: best.rows };
}

function readTableFileAsRows(file, forPlan){
  return new Promise((resolve, reject) => {
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    const isDelimited = ['csv','tsv','txt'].includes(ext);
    const r = new FileReader();
    r.onload = (ev) => {
      try{
        if(isDelimited){
          const text = decodeTextBuffer(ev.target.result);
          const delim = ext === 'tsv' ? '\t' : (ext === 'csv' ? ',' : guessDelimiter(text));
          resolve({ name: file.name, rows: parseDelimitedText(text, delim) });
        } else {
          if(!LIB_XLSX_OK) throw new Error('Thư viện đọc Excel (SheetJS) chưa tải được — cần Internet. Hãy mở file này bằng Chrome có mạng, hoặc lưu dữ liệu dạng .csv/.tsv rồi tải lên.');
          const wb = XLSX.read(ev.target.result, {type:'array', cellDates:false});
          resolve(forPlan ? extractPlanSheetRows(wb) : extractRawRows(wb));
        }
      }catch(err){ reject(err); }
    };
    r.onerror = () => reject(new Error('Không đọc được file.'));
    r.readAsArrayBuffer(file);
  });
}

function aggregatePlanRows(rows, planType){
  if(!rows.length) throw new Error('File không có dữ liệu.');
  const headerIdx = locatePlanHeaderRow(rows);
  const headers = rows[headerIdx];
  const colItem = findCol(headers, PLAN_ITEM_CANDS);
  const colQty  = findCol(headers, PLAN_QTY_CANDS);
  if(colItem === -1 || colQty === -1){
    const found = headers.map((h,i) => `[${i}] "${h ?? ''}"`).join('  ');
    const missing = [colItem === -1 ? 'Item No. / TTI Model' : null, colQty === -1 ? 'Số lượng (QTY)' : null].filter(Boolean).join(', ');
    throw new Error(`Thiếu cột bắt buộc: ${missing}. Các cột đọc được: ${found || '(không đọc được)'}`);
  }
  const colContainer = findCol(headers, ['containerno', 'container no', 'container_no', 'so container', 'cont no', 'cont#', 'cont', 'seq', 'container']);
  const colDC         = findCol(headers, ['dc', 'destination', 'pod', 'poe', 'cang den', 'des']);
  const colWH          = findCol(headers, ['wh', 'warehouse', 'kho xuat']);
  const colLoadDate    = findCol(headers, ['loading date', 'ngay xuat', 'etd', 'ship date', 'ngay', 'date']);
  const colCustomerPO  = findCol(headers, ['customer po', 'cust po', 'endbuyer po', 'endbyer po', 'po']);
  const colPlanTime    = findCol(headers, ['plan time', 'gio load', 'thoi gian', 'time']);
  const colCTN         = findCol(headers, ['ctn', 'carton', 'qty (ctr)', 'ctr', 'thung can', 'thung']);
  const colCBM         = findCol(headers, ['cbm']);
  const colType        = findCol(headers, ['container type', 'loai container', 'cont size', 'size', 'type']);
  const colInvoice     = findCol(headers, ['invoice#', 'invoice', 'inv']);
  const colCSR         = planType === 'Row' ? findCol(headers, ['ui']) : findCol(headers, ['csr#', 'csr', 'cr']);

  const usedCols = new Set([colItem, colQty, colContainer, colDC, colWH, colLoadDate, colCustomerPO, colPlanTime, colCTN, colCBM, colType, colInvoice, colCSR].filter(i => i !== -1));
  const maxKnownIdx = usedCols.size ? Math.max(...usedCols) : -1;
  const locationCols = headers
    .map((h, i) => ({ idx: i, name: (h || '').toString().trim() }))
    .filter(c => c.idx > maxKnownIdx && c.name && classifyKho(c.name) !== 'Chua phan loai');

  const byItem = {};
  const byDC = {};
  const byWH = {};
  const containers = new Set();
  const detailRows = [];
  let rowCount = 0, totalQty = 0;
  let nearestDate = null;

  const lastValues = {};

  for(let i=headerIdx+1;i<rows.length;i++){
    const r = rows[i];
    if(!r || r[colItem] === null || r[colItem] === undefined || String(r[colItem]).trim() === '') continue;
    const contVal = colContainer !== -1 ? r[colContainer] : undefined;
    const isContinuationRow = colContainer !== -1 && (contVal === null || contVal === undefined || String(contVal).trim() === '');
    if(isContinuationRow){
      for(let c=0;c<headers.length;c++){
        if(c === colItem || c === colQty) continue;
        if(r[c] === null || r[c] === undefined || r[c] === ''){
          if(lastValues[c] !== undefined) r[c] = lastValues[c];
        }
      }
    }
    for(let c=0;c<headers.length;c++){
      if(c === colItem || c === colQty) continue;
      if(r[c] !== null && r[c] !== undefined && r[c] !== '') lastValues[c] = r[c];
    }
    const item = normalizeItemCode(r[colItem]).toLowerCase();
    const qty = parseNumber(r[colQty]);
    byItem[item] = (byItem[item] || 0) + qty;
    if(colDC !== -1 && r[colDC]){ const dc = String(r[colDC]).trim(); byDC[dc] = (byDC[dc]||0) + qty; }
    if(colWH !== -1 && r[colWH]){ const wh = String(r[colWH]).trim(); byWH[wh] = (byWH[wh]||0) + qty; }
    if(colContainer !== -1 && r[colContainer]) containers.add(String(r[colContainer]).trim());
    const loadDate = colLoadDate !== -1 ? parseDateCell(r[colLoadDate]) : null;
    if(loadDate && (!nearestDate || loadDate < nearestDate)) nearestDate = loadDate;
    const locations = {};
    locationCols.forEach(c => {
      const v = r[c.idx];
      if(v !== null && v !== undefined && v !== '') locations[c.name] = parseNumber(v);
    });
    detailRows.push({
      loadDate,
      planTime: colPlanTime !== -1 ? formatTimeCell(r[colPlanTime]) : '',
      item: normalizeItemCode(r[colItem]),
      custPo: colCustomerPO !== -1 && r[colCustomerPO] != null ? String(r[colCustomerPO]).trim() : '',
      qty,
      ctn: colCTN !== -1 ? r[colCTN] : null,
      cbm: colCBM !== -1 ? r[colCBM] : null,
      type: colType !== -1 && r[colType] != null ? String(r[colType]).trim() : '',
      containerNo: colContainer !== -1 && r[colContainer] != null ? String(r[colContainer]).trim() : '',
      invoice: colInvoice !== -1 && r[colInvoice] != null ? String(r[colInvoice]).trim() : '',
      csr: colCSR !== -1 && r[colCSR] != null ? String(r[colCSR]).trim() : '',
      locations,
    });
    rowCount++; totalQty += qty;
  }
  if(!rowCount) throw new Error('Không đọc được dòng dữ liệu hợp lệ nào.');

  const topItems = Object.entries(byItem).sort((a,b)=>b[1]-a[1]).slice(0,8);
  const topDC = Object.entries(byDC).sort((a,b)=>b[1]-a[1]).slice(0,8);
  const pad = n => String(n).padStart(2,'0');
  const nearestDateStr = nearestDate ? `${pad(nearestDate.getUTCDate())}/${pad(nearestDate.getUTCMonth()+1)}/${nearestDate.getUTCFullYear()}` : null;

  return {
    byItem, rowCount, totalQty,
    itemCount: Object.keys(byItem).length,
    containerCount: colContainer !== -1 ? containers.size : null,
    topItems, topDC: colDC !== -1 ? topDC : null,
    nearestDateStr, detailRows,
    locationColumns: locationCols.map(c => c.name),
  };
}

// Gộp NHIỀU thay đổi liên tiếp (VD: Row rồi FC rồi HCP trong vài giây) thành ĐÚNG 1 request lưu lên
// Cloud duy nhất, thay vì mỗi lần đổi gửi 1 request riêng — tránh mọi khả năng các request gần nhau
// bị xử lý sai thứ tự (kể cả phía Cloud mà mình không kiểm soát được), vì chỉ còn lại 1 request thì
// không có gì để tranh chấp thứ tự nữa. Dùng CHUNG cho mọi hành động "hay bị mất do quên bấm Lưu" —
// mỗi loại (Plan, Đề xuất kiểm, Xác nhận...) có timerKey riêng để không bị huỷ debounce chéo nhau.
const _autoSaveTimers = {};
// TẤT CẢ các timerKey đang CÒN CHỜ (chưa lưu xong) — dùng để biết khi nào THỰC SỰ an toàn để báo
// "đã lưu hết". QUAN TRỌNG: nếu 2 hành động khác nhau (VD: Xác nhận 1 dòng VÀ Xoá danh sách) xảy ra
// gần nhau, mỗi cái có hàng đợi 2 giây RIÊNG — nếu hàng đợi A xong TRƯỚC gọi clearUnsavedChanges()
// ngay, cờ "đã lưu" sẽ bị xoá dù hàng đợi B (Xoá danh sách) VẪN ĐANG CHỜ chưa gửi lên Cloud. Lúc đó
// Realtime tưởng "an toàn" sẽ áp dụng nhầm dữ liệu Cloud CŨ (chưa có thay đổi B) đè lên, làm thay đổi
// B "biến mất/sống lại" dù mới thao tác được 1-2 giây trước — đây chính là lỗi đã gặp phải.
const _pendingAutoSaveKeys = new Set();
function scheduleAutoSaveToCloud(timerKey, keys, label){
  if(typeof CloudVault === 'undefined' || !CloudVault.url || !CloudVault.token) return;
  clearTimeout(_autoSaveTimers[timerKey]);
  _pendingAutoSaveKeys.add(timerKey);
  const statusEl = document.getElementById('upload-status');
  if(statusEl){ statusEl.className = 'upload-status'; statusEl.textContent = `● ${label} vừa đổi — chuẩn bị tự lưu lên Cloud…`; }
  _autoSaveTimers[timerKey] = setTimeout(async () => {
    try{
      // Chỉ gửi ĐÚNG các mục liên quan (gói nhỏ) bằng writeMerge() — KHÔNG gửi kèm khối tồn kho/
      // lịch sử khổng lồ (có thể tới hàng MB), để không bị "chết chung" nếu mạng chậm/đứt giữa chừng.
      await CloudVault.writeMerge(keys);
      _pendingAutoSaveKeys.delete(timerKey);
      // CHỈ báo "đã lưu hết" (mở khoá cho Realtime áp dụng dữ liệu mới) khi KHÔNG CÒN hàng đợi nào
      // khác đang chờ — nếu còn, giữ nguyên cờ "chưa lưu" để Realtime tiếp tục chờ đúng.
      if(_pendingAutoSaveKeys.size === 0 && typeof clearUnsavedChanges === 'function') clearUnsavedChanges();
      if(statusEl){ statusEl.className = 'upload-status ok'; statusEl.textContent = `✓ ${label} đã lưu lên Cloud lúc ${fmtDateTime(new Date())} (${fmtBytes(CloudVault._lastWriteBytes)}).`; }
    }catch(err){
      _pendingAutoSaveKeys.delete(timerKey);
      if(statusEl){ statusEl.className = 'upload-status err'; statusEl.textContent = `⚠ ${label} CHƯA LƯU ĐƯỢC lên Cloud: ${err.message} — bấm nút "Lưu" ở đầu trang để thử lại, nếu không sẽ mất khi mở file/thiết bị khác.`; }
    }
  }, 2000);
}
function schedulePlanAutoSaveToCloud(){
  scheduleAutoSaveToCloud('plan', [STORAGE_KEY_PLANS], 'Plan vừa tải/xoá');
}

document.querySelectorAll('.btn-plan').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelector(`.plan-file-input[data-plan="${btn.dataset.plan}"]`).click();
  });
});

document.querySelectorAll('.plan-file-input').forEach(input => {
  input.addEventListener('change', async (e) => {
    const type = input.dataset.plan;
    const file = e.target.files[0];
    if(!file) return;
    const statusEl = document.querySelector(`.plan-status[data-plan-status="${type}"]`);
    const btnEl = document.querySelector(`.btn-plan[data-plan="${type}"]`);
    const clearBtn = document.querySelector(`.btn-plan-clear[data-plan-clear="${type}"]`);
    if(statusEl){ statusEl.className = 'plan-status'; statusEl.textContent = `Đang đọc "${file.name}"…`; }
    planEditingTypes.delete(type); // tải file mới đè lên thì thoát chế độ Sửa (nếu đang bật) của loại Plan này
    try{
      const { rows } = await readTableFileAsRows(file, true);
      const agg = aggregatePlanRows(rows, type);
      // Tính khác biệt (container MỚI / đổi Ngày Load-Giờ Plan) so với dữ liệu CŨ của đúng loại Plan
      // này — PHẢI làm TRƯỚC khi planData[type] bị ghi đè bên dưới, vì cần đúng danh sách chi tiết CŨ
      // để so sánh (xem computePlanContainerChanges()).
      computePlanContainerChanges(type, planData[type] ? planData[type].detailRows : null, agg.detailRows);
      planData[type] = { ...agg, fileName: file.name };
      if(btnEl) btnEl.classList.add('loaded');
      if(clearBtn) clearBtn.classList.add('show');
      renderPlanPanel();
      renderKhoSearchPage();
      touchUpdatedAt();
      saveStateToStorage();
      if(statusEl){ statusEl.className = 'plan-status ok'; statusEl.textContent = `✓ ${file.name} · ${agg.itemCount} mã · ${fmt(agg.totalQty)} Pcs`; }
      // Cập nhật thư viện CBM/đơn vị theo từng mã hàng — mã trùng có CBM khác rõ rệt sẽ hỏi lại qua
      // popup, mã mới/khớp thì tự cập nhật luôn.
      itemCbmMergeFromPlan(extractItemCbmFromPlanRows(agg.detailRows), `Plan ${type} — ${file.name}`);
      // Plan hay bị mất do quên bấm "Lưu" thủ công — lên lịch tự lưu lên Cloud (gộp các lần tải
      // gần nhau thành 1 request duy nhất, xem schedulePlanAutoSaveToCloud() ở trên).
      schedulePlanAutoSaveToCloud();
    }catch(err){
      if(statusEl){ statusEl.className = 'plan-status err'; statusEl.textContent = `✗ Lỗi: ${err.message}`; }
    }finally{
      input.value = '';
    }
  });
});

document.querySelectorAll('.btn-plan-clear').forEach(btn => {
  btn.addEventListener('click', () => {
    const type = btn.dataset.planClear;
    planData[type] = null;
    planEditingTypes.delete(type); // xoá cả Plan thì thoát luôn chế độ Sửa (nếu đang bật) — không còn dữ liệu để sửa nữa
    // Xoá luôn cờ MỚI/Đổi giờ đang treo của đúng loại Plan này — không còn dữ liệu để cờ đó gắn vào nữa.
    Object.keys(planContainerChangeInfo).forEach(k => { if(k.startsWith(type + '|')) delete planContainerChangeInfo[k]; });
    const statusEl = document.querySelector(`.plan-status[data-plan-status="${type}"]`);
    const btnEl = document.querySelector(`.btn-plan[data-plan="${type}"]`);
    const clearBtn = document.querySelector(`.btn-plan-clear[data-plan-clear="${type}"]`);
    if(statusEl){ statusEl.className = 'plan-status'; statusEl.textContent = 'Chưa tải'; }
    if(btnEl) btnEl.classList.remove('loaded');
    if(clearBtn) clearBtn.classList.remove('show');
    renderPlanPanel();
    renderKhoSearchPage();
    touchUpdatedAt();
    saveStateToStorage();
    // Y HỆT lúc TẢI Plan lên — XOÁ Plan cũng phải tự lưu lên Cloud ngay, nếu không thì chỉ mới xoá
    // trên máy này, Cloud vẫn còn giữ bản Plan cũ. Lần đọc lại Cloud tiếp theo (tải lại trang, đổi
    // thiết bị, hay chính Realtime) sẽ kéo bản CŨ (chưa xoá) về, làm Plan "sống lại" y như cũ.
    schedulePlanAutoSaveToCloud();
  });
});

const planCardsEl = document.getElementById('plan-cards');

// buildItemIndex()/buildItemCustPoIndex() luôn được gọi với CHÍNH currentData (không có nơi nào
// truyền data khác) — CACHE lại theo tham chiếu data, vì trong 1 lần renderPlanPanel() cả 2 hàm này
// bị gọi tới 4 lần (1 lần trong buildCombinedPlanCompareTable() + tối đa 3 lần, mỗi Plan Row/FC/HCP,
// trong buildCompareTable()) — mỗi lần đều quét lại TOÀN BỘ kho_detail (mọi kho) từ đầu, dù dữ liệu
// tồn kho không hề đổi giữa các lần gọi đó. Tự làm mới khi data đổi tham chiếu (currentData luôn được
// GÁN LẠI object mới khi có dữ liệu mới, không sửa tại chỗ, nên so sánh tham chiếu là đủ).
let _itemIndexCache = null, _itemIndexForData = null;
function buildItemIndex(data){
  if(_itemIndexForData === data && _itemIndexCache) return _itemIndexCache;
  const idx = {};
  if(!data || !data.kho_detail){ _itemIndexCache = idx; _itemIndexForData = data; return idx; }
  for(const kho of Object.keys(data.kho_detail)){
    for(const [item, , locator, oqc, qty] of data.kho_detail[kho]){
      if(PROD_LOCATOR_RE.test(locator || '')) continue; // loại vị trí "Prod" — không tính vào So sánh Plan / Tổng hợp 3 Plan
      const key = item.toLowerCase();
      idx[key] = idx[key] || { byKho: {}, pass: 0, ng: 0, other: 0 };
      idx[key].byKho[kho] = (idx[key].byKho[kho] || 0) + qty;
      const o = (oqc || '').toUpperCase();
      if(o === 'PASS') idx[key].pass += qty;
      else if(o === 'NG') idx[key].ng += qty;
      else idx[key].other += qty;
    }
  }
  _itemIndexCache = idx;
  _itemIndexForData = data;
  return idx;
}

let _itemCustPoIndexCache = null, _itemCustPoIndexForData = null;
function buildItemCustPoIndex(data){
  if(_itemCustPoIndexForData === data && _itemCustPoIndexCache) return _itemCustPoIndexCache;
  const idx = {};
  if(!data || !data.kho_detail){ _itemCustPoIndexCache = idx; _itemCustPoIndexForData = data; return idx; }
  for(const kho of Object.keys(data.kho_detail)){
    for(const [item, custpo, locator, oqc, qty] of data.kho_detail[kho]){
      if(PROD_LOCATOR_RE.test(locator || '')) continue; // loại vị trí "Prod" — không tính vào So sánh Plan / Tổng hợp 3 Plan
      const key = item.toLowerCase() + '\u241F' + (custpo || '').toLowerCase();
      idx[key] = idx[key] || { byKho: {}, pass: 0, ng: 0, other: 0 };
      idx[key].byKho[kho] = (idx[key].byKho[kho] || 0) + qty;
      const o = (oqc || '').toUpperCase();
      if(o === 'PASS') idx[key].pass += qty;
      else if(o === 'NG') idx[key].ng += qty;
      else idx[key].other += qty;
    }
  }
  _itemCustPoIndexCache = idx;
  _itemCustPoIndexForData = data;
  return idx;
}

function buildCompareTable(type){
  const khoOrder = (currentData && currentData.kho_order) || [];
  const poIdx = buildItemCustPoIndex(currentData);
  const itemIdx = buildItemIndex(currentData);

  // Container nào đã "Pick xong" (tự động 100% hoặc đã đánh dấu thủ công) thì không tính SL của các
  // dòng Plan thuộc container đó vào "còn cần" nữa — tránh báo Thiếu nhầm cho hàng đã xuất đi thực tế.
  const doneContSet = new Set(
    (contPickAllRows || [])
      .filter(r => r.status === 'done' || r.status === 'manualDone')
      .map(r => r.instanceKey)
  );

  const planPairs = {};
  for(const r of (planData[type].detailRows || [])){
    const rLoadDateStr = r.loadDate ? fmtDate(r.loadDate) : '';
    const rPlanTimeStr = r.planTime || '';
    if(isContainerHidden(type, r.containerNo, rLoadDateStr, rPlanTimeStr)) continue; // container đã xoá khỏi Plan — bỏ qua hẳn
    const custpo = (r.custPo && r.custPo.trim()) ? r.custPo.trim() : '(Khong co)';
    const key = r.item.toLowerCase() + '\u241F' + custpo.toLowerCase();
    if(!planPairs[key]) planPairs[key] = { item: r.item, custpo, qty: 0 };
    const isDone = r.containerNo && doneContSet.has(contInstanceKey(type, r.containerNo, rLoadDateStr, rPlanTimeStr));
    if(isDone) continue;
    planPairs[key].qty += r.qty;
  }

  const rows = Object.values(planPairs).map(p => {
    const anyPO = p.custpo === '(Khong co)';
    let inv;
    if(anyPO){
      inv = itemIdx[p.item.toLowerCase()] || { byKho:{}, pass:0, ng:0, other:0 };
    } else {
      const key = p.item.toLowerCase() + '\u241F' + p.custpo.toLowerCase();
      inv = poIdx[key] || { byKho:{}, pass:0, ng:0, other:0 };
    }
    const khoQtys = khoOrder.map(k => inv.byKho[k] || 0);
    const totalOnHand = inv.pass || 0;
    const itemAnyPO = khoOrder.reduce((s,k) => s + ((itemIdx[p.item.toLowerCase()]||{}).byKho?.[k] || 0), 0);
    const poMismatch = !anyPO && totalOnHand === 0 && itemAnyPO > 0;
    // Nhóm SPP đã tick "Đủ hàng" ở popup của Tổng hợp 3 Plan (xem toggleSppOk) — LIÊN KẾT lại để
    // bảng so sánh riêng theo từng Plan (Row/FC/HCP) này cũng coi đúng dòng đó là Đủ, không còn báo
    // Thiếu lệch với popup SPP nữa (dùng CHUNG đúng 1 khoá sppOkKey/1 trạng thái sppManualOk).
    const isSpp = ccIsSppItem(p.item);
    const manualOk = isSpp && !!sppManualOk[sppOkKey(p.item, p.custpo)];
    return { item: p.item, custpo: p.custpo, anyPO, khoQtys, totalOnHand, pass: inv.pass, ng: inv.ng,
              planQty: p.qty, diff: totalOnHand - p.qty, poMismatch, itemAnyPO, isSpp, manualOk };
  }).sort((a,b) => a.diff - b.diff);

  const shortCount = rows.filter(r => r.diff < 0 && !r.manualOk).length;
  const okCount = rows.length - shortCount;
  const poMismatchCount = rows.filter(r => r.poMismatch).length;

  const headKho = khoOrder.map(k => `<th style="text-align:right">${k.replace('Kho ','')}</th>`).join('');
  const colCount = 2 + khoOrder.length + 6;
  const bodyRows = rows.map(r => {
    const khoCells = r.khoQtys.map(q => `<td class="num">${fmt(q)}</td>`).join('');
    const short = r.diff < 0 && !r.manualOk;
    const poCell = r.anyPO
      ? `<span class="po-any">Bất kỳ PO</span>`
      : (r.poMismatch
        ? `${r.custpo} <span class="po-warn" title="Không tìm thấy PO này trong tồn kho, nhưng mã hàng còn ${fmt(r.itemAnyPO)} Pcs ở PO khác">⚠</span>`
        : r.custpo);
    return `<tr class="compare-row">
      <td><span class="item-link" data-item="${r.item}" data-po="${r.anyPO ? '' : r.custpo}">${r.item} <span class="item-link-arrow">▸</span></span></td>
      <td>${poCell}</td>
      ${khoCells}
      <td class="num" style="color:var(--text); font-weight:700;">${fmt(r.totalOnHand)}</td>
      <td class="num oqc-pass">${fmt(r.pass)}</td>
      <td class="num oqc-ng">${fmt(r.ng)}</td>
      <td class="num" style="color:${PLAN_COLORS[type]}">${fmt(r.planQty)}</td>
      <td class="num ${short?'diff-short':'diff-ok'}">${r.diff>=0?'+':''}${fmt(r.diff)}</td>
      <td>${r.manualOk
          ? `<span class="compare-badge ok" title="Đã tick tay Đủ hàng (SPP) ở popup Tổng hợp 3 Plan — coi như đã pick 100%">Đủ ✓</span>`
          : `<span class="compare-badge ${short?'short':'ok'}">${short?'Thiếu':'Đủ'}</span>`}
    </td></tr>`;
  }).join('');

  return { html: `
    <table class="plan-detail-table compare-table" data-colspan="${colCount}">
      <thead><tr>
        <th>Item No.</th><th>Cust PO</th>${headKho}
        <th style="text-align:right">Tổng tồn (PASS)</th>
        <th style="text-align:right">PASS</th>
        <th style="text-align:right">NG</th>
        <th style="text-align:right">SL Plan</th>
        <th style="text-align:right">Chênh lệch</th>
        <th>Trạng thái</th>
      </tr></thead>
      <tbody>${bodyRows}</tbody>
    </table>`, okCount, shortCount, poMismatchCount, rows, khoOrder };
}

// Vị trí "Prod" (VD: D3B-FG-PROD) là khu trung chuyển/sản xuất, KHÔNG phải tồn kho lưu trữ thật —
// dùng chung 1 regex để loại vị trí này ở những chỗ tính "tồn kho khả dụng để pick".
const PROD_LOCATOR_RE = /prod/i;

// Bảng tra cứu (Map) item -> mảng {kho,locator,custpo,oqc,qty} — dựng 1 LẦN từ kho_detail và tái sử
// dụng cho mọi lần gọi buildItemLocatorDetail(), thay vì quét lại TOÀN BỘ kho_detail (hàng nghìn dòng)
// mỗi lần gọi. buildItemLocatorDetail() gọi rất nhiều lần trong 1 lần render (VD: 1 lần/mã hàng/
// container ở renderContainerPickingOverview()) nên quét lại từ đầu mỗi lần gây giật khi thao tác.
// Tự làm mới khi currentData đổi tham chiếu (mỗi lần tải file mới/đồng bộ Cloud đều gán currentData =
// object MỚI, không sửa tại chỗ — xem renderDashboard()/_smartReadAll() — nên so sánh tham chiếu là đủ).
let _itemLocatorIndexCache = null;
let _itemLocatorIndexForData = null;
function getItemLocatorIndex(){
  if(_itemLocatorIndexForData === currentData && _itemLocatorIndexCache) return _itemLocatorIndexCache;
  const idx = new Map();
  if(currentData && currentData.kho_detail){
    for(const kho of Object.keys(currentData.kho_detail)){
      for(const [it, custpo, locator, oqc, qty] of currentData.kho_detail[kho]){
        const key = it.toLowerCase();
        let arr = idx.get(key);
        if(!arr){ arr = []; idx.set(key, arr); }
        arr.push({ kho, locator, custpo, oqc, qty });
      }
    }
  }
  _itemLocatorIndexCache = idx;
  _itemLocatorIndexForData = currentData;
  return idx;
}

function buildItemLocatorDetail(item, po, excludeProd){
  if(!currentData || !currentData.kho_detail) return [];
  const entries = getItemLocatorIndex().get(item.toLowerCase()) || [];
  const poLower = po ? po.trim().toLowerCase() : '';
  const rows = [];
  for(const e of entries){
    if(poLower && (e.custpo || '').trim().toLowerCase() !== poLower) continue;
    if(excludeProd && PROD_LOCATOR_RE.test(e.locator || '')) continue;
    rows.push(e);
  }
  return rows.sort((a,b) => b.qty - a.qty);
}

function renderItemDetailRowHtml(item, colspan, po){
  const rows = buildItemLocatorDetail(item, po);
  const poNote = po ? ` — chỉ PO <b>${po}</b>` : '';
  if(!rows.length){
    const msg = po
      ? `Không tìm thấy tồn kho cho mã hàng "${item}" ở đúng PO "${po}" (có thể mã hàng đang tồn ở PO khác)`
      : `Không tìm thấy dữ liệu tồn kho cho mã hàng "${item}"`;
    return `<tr class="item-detail-row" data-detail-for="${item}" data-detail-po="${po||''}"><td colspan="${colspan}"><div class="item-detail-empty">${msg}</div></td></tr>`;
  }
  const totalQty = rows.reduce((s,r)=>s+r.qty,0);
  const body = rows.map(r => `
    <tr>
      <td><span class="tag-kho">${r.kho.replace('Kho ','')}</span></td>
      <td>${r.locator}</td>
      <td>${r.custpo}</td>
      <td>${oqcBadge(r.oqc)}</td>
      <td class="num">${fmt(r.qty)}</td>
    </tr>`).join('');
  return `<tr class="item-detail-row" data-detail-for="${item}" data-detail-po="${po||''}"><td colspan="${colspan}">
    <div class="item-detail-wrap">
      <div class="item-detail-title">Chi tiết mã hàng <b>${item}</b>${poNote} — ${rows.length} vị trí, tổng ${fmt(totalQty)} Pcs</div>
      <table class="item-detail-mini">
        <thead><tr><th>Kho</th><th>Locator</th><th>Cust PO</th><th>OQC</th><th style="text-align:right">SL tồn</th></tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>
  </td></tr>`;
}

document.addEventListener('click', (e) => {
  const link = e.target.closest('.item-link');
  if(!link) return;
  const tr = link.closest('tr');
  const table = link.closest('table[data-colspan]');
  if(!tr || !table) return;
  const colspan = Number(table.dataset.colspan || 8);
  const item = link.dataset.item;
  const po = link.dataset.po || '';
  const existing = tr.nextElementSibling;
  if(existing && existing.classList.contains('item-detail-row')){
    const wasThisItem = existing.dataset.detailFor === item && (existing.dataset.detailPo || '') === po;
    existing.remove();
    link.classList.remove('open');
    if(wasThisItem) return;
  }
  table.querySelectorAll('tr.item-detail-row').forEach(r => r.remove());
  table.querySelectorAll('.item-link.open').forEach(l => l.classList.remove('open'));
  tr.insertAdjacentHTML('afterend', renderItemDetailRowHtml(item, colspan, po));
  link.classList.add('open');
});

function exportCompareToExcel(type){
  if(!planData[type]) return;
  if(!LIB_XLSX_OK){
    alert('Không xuất được Excel: thư viện SheetJS chưa tải được (cần Internet). Hãy mở file này bằng Chrome có kết nối mạng rồi thử lại.');
    return;
  }
  const compare = buildCompareTable(type);
  const khoOrder = compare.khoOrder || [];

  const summaryHeader = ['Item No.', 'Cust PO', ...khoOrder.map(k => k.replace('Kho ', '')), 'Tổng tồn (PASS)', 'PASS', 'NG', 'SL Plan', 'Chênh lệch', 'Trạng thái', 'Nhóm'];
  const summaryRows = compare.rows.map(r => [
    r.item,
    r.anyPO ? 'Bất kỳ PO' : r.custpo + (r.poMismatch ? ' (PO không khớp tồn kho)' : ''),
    ...r.khoQtys,
    r.totalOnHand, r.pass, r.ng, r.planQty, r.diff,
    (r.diff >= 0 || r.manualOk) ? 'Đủ' : 'Thiếu',
    r.isSpp ? (r.manualOk ? 'SPP - đã tick Đủ hàng tay' : 'SPP') : ''
  ]);

  const detailHeader = ['OQC', 'Kho', 'Item No.', 'Cust PO (tồn kho)', 'Locator', 'SL tồn'];
  const detailRows = [];
  compare.rows.forEach(r => {
    const locs = buildItemLocatorDetail(r.item, null, true); // loại vị trí "Prod" khỏi Excel So sánh Plan
    if(!locs.length){
      detailRows.push(['', '(khong co ton kho)', r.item, '', '', 0]);
    } else {
      locs.forEach(l => detailRows.push([l.oqc, l.kho.replace('Kho ', ''), r.item, l.custpo, l.locator, l.qty]));
    }
  });

  const wb = XLSX.utils.book_new();
  const ws1 = XLSX.utils.aoa_to_sheet([summaryHeader, ...summaryRows]);
  ws1['!cols'] = summaryHeader.map((h,i) => ({ wch: i === 0 ? 14 : (i === 1 ? 22 : 11) }));
  const ws2 = XLSX.utils.aoa_to_sheet([detailHeader, ...detailRows]);
  ws2['!cols'] = detailHeader.map((h,i) => ({ wch: i === 2 ? 14 : (i === 4 ? 18 : 14) }));

  XLSX.utils.book_append_sheet(wb, ws1, `So sanh Plan ${type}`.slice(0,31));
  XLSX.utils.book_append_sheet(wb, ws2, 'Chi tiet vi tri'.slice(0,31));

  const pad = n => String(n).padStart(2,'0');
  const now = new Date();
  const stamp = `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}`;
  XLSX.writeFile(wb, `So_sanh_Ton_kho_vs_Plan_${type}_${stamp}.xlsx`);
}

document.addEventListener('click', (e) => {
  const btn = e.target.closest('.btn-export-excel');
  if(!btn) return;
  exportCompareToExcel(btn.dataset.exportPlan);
});

/* ============ HÀM TÍNH PICKING STATUS MỚI – CHỈ DỰA TRÊN CSR ============ */
function buildPickingIndex(data){
  // Index theo item + CSR (ref) để tính PASS
  const idx = {};
  if(!data || !data.kho_detail) return idx;
  for(const kho of Object.keys(data.kho_detail)){
    for(const [item, , locator, oqc, qty, ref] of data.kho_detail[kho]){
      if((oqc || '').toUpperCase() !== 'PASS') continue;
      // Nếu có ref, index theo item+ref
      if(ref && ref.trim()){
        const key = item.toLowerCase() + '|' + ref.trim().toLowerCase();
        idx[key] = (idx[key] || 0) + qty;
      }
      // Đã bỏ hoàn toàn việc index theo locator PICK
    }
  }
  return idx;
}

function contDomId(type, cNo){
  return (String(type) + '-' + String(cNo)).replace(/[^a-zA-Z0-9_-]+/g, '_');
}

function combinedRowDomId(item, custpo){
  return ('combined-row-' + String(item) + '-' + String(custpo || 'anyPO')).replace(/[^a-zA-Z0-9_-]+/g, '_');
}

const CONT_PICK_STATUS_LABEL = { notStarted: 'Chưa pick', inProgress: 'Đang pick', done: 'Pick xong', manualDone: 'Pick xong' };
const CONT_PICK_STATUS_COLOR = { notStarted: 'var(--red)', inProgress: 'var(--amber-bright)', done: 'var(--teal)', manualDone: 'var(--violet)' };
const CONT_PICK_STATUS_ORDER = { notStarted: 0, inProgress: 1, done: 2, manualDone: 2 };

// Khoá định danh 1 "LƯỢT XUẤT" container — ghép Loại Plan + Số cont + Ngày Load + Giờ Plan.
// LÝ DO: cùng 1 số cont có thể được dùng lại cho nhiều lượt xuất khác nhau (Ngày Load / Giờ Plan
// khác nhau) — đây là các container THỰC TẾ KHÁC NHAU, không phải trùng lặp — nên phải tách thành
// các dòng/trạng thái RIÊNG (Pick, Ẩn, chọn Kho thủ công...), không được gộp chung chỉ vì trùng số cont.
function contInstanceKey(type, cNo, loadDate, planTime){
  return type + '|' + cNo + '|' + (loadDate || '') + '|' + (planTime || '');
}

// Đánh dấu "pick xong" THỦ CÔNG cho 1 container — chỉ đổi NHÃN hiển thị để nhân viên dễ theo dõi,
// không hề đụng tới số liệu tồn kho/Plan ở bất kỳ đâu khác trong dashboard. Lưu qua LS nên cũng
// được đồng bộ theo cơ chế Lưu/Cloud sẵn có, và dùng chung khi mở trên nhiều máy/nhiều người.
let manualPickedContainers = {};
const STORAGE_KEY_MANUAL_PICKED = 'tn5_dashboard_manual_picked_v1';
function togglePickedManual(type, cNo, loadDate, planTime){
  const key = contInstanceKey(type, cNo, loadDate, planTime);
  if(manualPickedContainers[key]) delete manualPickedContainers[key];
  else manualPickedContainers[key] = { at: Date.now() };
  _localContOverridesDirty = true;
  saveStateToStorage();
  scheduleAutoSaveToCloud('contoverride', [STORAGE_KEY_MANUAL_PICKED], 'Đánh dấu Pick xong tay');
  renderPlanPanel(); // vẽ lại cả bảng so sánh SL Plan vs Tồn kho để cập nhật ngay, không trễ nhịp
  if(typeof renderKioskPage === 'function' && document.getElementById('page-kiosk') && document.getElementById('page-kiosk').style.display !== 'none'){
    renderKioskPage();
  }
  if(typeof renderAlertsPanel === 'function') renderAlertsPanel();
}

// Đánh dấu container MỚI xuất hiện / vừa đổi Ngày Load-Giờ Plan so với lần tải Plan TRƯỚC ĐÓ của
// đúng loại Plan này (Row/FC/HCP) — giúp nhận ra ngay dòng Plan nào vừa thay đổi mà không cần tự đối
// chiếu file cũ/mới bằng tay (theo yêu cầu — Plan hay thay đổi, bảng container nhiều dòng khó theo dõi).
// Chỉ đánh dấu khi ĐÃ CÓ dữ liệu cũ để so — lần tải ĐẦU TIÊN cho 1 loại Plan không đánh dấu gì cả, vì
// lúc đó "mọi thứ đều mới" là vô nghĩa (không có gì để so sánh). Lưu CỤC BỘ (không đồng bộ Cloud) —
// thông tin này chỉ có ý nghĩa ngay lúc vừa tải trên đúng máy vừa tải, không cần đồng bộ nhiều máy.
let planContainerChangeInfo = {}; // contInstanceKey(...) -> { status: 'new'|'changed', at }
const STORAGE_KEY_PLAN_CHANGE_INFO = 'tn5_dashboard_plan_change_info_v1';

// So sánh danh sách chi tiết Plan CŨ (trước khi tải file mới đè lên) với danh sách MỚI của ĐÚNG 1
// loại Plan (Row/FC/HCP) — gọi ngay SAU khi đọc xong file mới nhưng TRƯỚC khi ghi đè planData[type].
function computePlanContainerChanges(type, oldDetailRows, newDetailRows){
  // Xoá hết cờ CŨ của đúng loại Plan này trước — mỗi lần tải mới là 1 mốc so sánh mới, không cộng dồn
  // cờ từ nhiều lần tải trước (VD: 1 container đã báo "MỚI" ở lần tải trước, lần này không còn gì khác
  // thì không nên tiếp tục hiện "MỚI" nữa).
  Object.keys(planContainerChangeInfo).forEach(k => { if(k.startsWith(type + '|')) delete planContainerChangeInfo[k]; });
  if(!oldDetailRows || !oldDetailRows.length) return; // lần tải ĐẦU TIÊN cho loại Plan này — không có gì để so

  const oldCnoSet = new Set();
  const oldInstanceSet = new Set();
  oldDetailRows.forEach(r => {
    const cNo = r.containerNo;
    if(!cNo || cNo === '—') return;
    oldCnoSet.add(cNo);
    oldInstanceSet.add(contInstanceKey(type, cNo, r.loadDate ? fmtDate(r.loadDate) : '', r.planTime || ''));
  });

  const seenNewInstance = new Set();
  (newDetailRows || []).forEach(r => {
    const cNo = r.containerNo;
    if(!cNo || cNo === '—') return;
    const key = contInstanceKey(type, cNo, r.loadDate ? fmtDate(r.loadDate) : '', r.planTime || '');
    if(seenNewInstance.has(key)) return; // 1 container có nhiều dòng (nhiều mã hàng) — chỉ cần xử lý 1 lần
    seenNewInstance.add(key);
    if(oldInstanceSet.has(key)) return; // y hệt lần tải trước (cùng cont, cùng ngày/giờ) — không đánh dấu gì
    // cNo đã từng xuất hiện ở lần tải trước (chỉ khác Ngày Load/Giờ Plan) -> "changed"; hoàn toàn chưa
    // từng thấy số cont này bao giờ -> "new".
    planContainerChangeInfo[key] = { status: oldCnoSet.has(cNo) ? 'changed' : 'new', at: Date.now() };
  });
}

// Ghi chú tự do cho TỪNG container ở bảng Thống kê Container (theo yêu cầu — thêm ô để tự điền, lưu
// Cloud mỗi lần điền xong). Khoá theo contInstanceKey(...) y hệt các tuỳ chỉnh container khác (Ẩn/Pick
// xong tay/Kho thủ công) — cùng nhóm 'contoverride' khi tự lưu lên Cloud, để gộp chung 1 lượt lưu.
let contPickComments = {};
const STORAGE_KEY_CONT_COMMENTS = 'tn5_dashboard_cont_comments_v1';
function saveContPickComment(instanceKey, text){
  const trimmed = String(text || '').trim();
  if(trimmed) contPickComments[instanceKey] = trimmed;
  else delete contPickComments[instanceKey]; // xoá trắng ô ghi chú -> dọn luôn key, không giữ chuỗi rỗng
  saveStateToStorage();
  scheduleAutoSaveToCloud('contoverride', [STORAGE_KEY_CONT_COMMENTS], 'Ghi chú container');
}

// Xoá (ẩn) 1 container khỏi bảng Plan — KHÔNG đụng tới file Excel Plan gốc đã tải lên, chỉ ẩn khỏi
// dashboard này. Có xác nhận trước khi xoá để tránh bấm nhầm, và có thể khôi phục lại bất cứ lúc nào.
let hiddenPlanContainers = {};
const STORAGE_KEY_HIDDEN_CONT = 'tn5_dashboard_hidden_containers_v1';
function deleteContainerFromPlan(type, cNo, loadDate, planTime){
  const key = contInstanceKey(type, cNo, loadDate, planTime);
  const loadInfo = (loadDate || planTime) ? ` (Load ${loadDate || '—'} ${planTime || ''})`.replace(/\s+\)/, ')') : '';
  const ok = window.confirm(
    `Xoá container ${type}-${cNo}${loadInfo} khỏi bảng Plan?\n\n` +
    `Container này sẽ bị ẨN khỏi bảng thống kê (không xoá/sửa gì trong file Excel Plan bạn đã tải lên). ` +
    `Bạn có thể khôi phục lại bất cứ lúc nào ở mục "Cont đã ẩn" phía trên bảng.`
  );
  if(!ok) return;
  hiddenPlanContainers[key] = { at: Date.now(), type, cNo, loadDate: loadDate || '', planTime: planTime || '' };
  _localContOverridesDirty = true;
  saveStateToStorage();
  scheduleAutoSaveToCloud('contoverride', [STORAGE_KEY_HIDDEN_CONT], 'Ẩn container');
  renderPlanPanel();
}
function restoreHiddenContainer(type, cNo, loadDate, planTime){
  const key = contInstanceKey(type, cNo, loadDate, planTime);
  delete hiddenPlanContainers[key];
  _localContOverridesDirty = true;
  saveStateToStorage();
  scheduleAutoSaveToCloud('contoverride', [STORAGE_KEY_HIDDEN_CONT], 'Khôi phục container');
  renderPlanPanel();
}

// Xoá VĨNH VIỄN dữ liệu của TẤT CẢ container đang bị ẩn khỏi Plan — khác với "Ẩn"/"Khôi phục" ở trên
// (chỉ LỌC KHỎI HIỂN THỊ, dữ liệu gốc vẫn còn nguyên trong planData mãi mãi cho tới khi tải Plan mới
// đè lên) — hàm này XOÁ THẬT các dòng đó khỏi planData[type].detailRows, dùng khi muốn dọn hẳn, không
// cần giữ lại phòng khôi phục nữa. KHÔNG đụng tới file Excel Plan gốc trên máy bạn — chỉ xoá bản đã
// tải vào dashboard (tải lại đúng file đó là có lại y hệt).
function deleteAllHiddenContainerData(){
  const keys = Object.keys(hiddenPlanContainers);
  if(!keys.length) return;
  const ok = window.confirm(
    `Xoá VĨNH VIỄN dữ liệu của ${keys.length} container đã ẩn khỏi Plan?\n\n` +
    `Khác với "Khôi phục" — sau khi xoá sẽ KHÔNG lấy lại được nữa (trừ khi tải lại đúng file Excel Plan gốc).`
  );
  if(!ok) return;
  PLAN_TYPES.forEach(type => {
    if(!planData[type]) return;
    planData[type].detailRows = (planData[type].detailRows || []).filter(r => {
      const rLoadDateStr = r.loadDate ? fmtDate(r.loadDate) : '';
      const rPlanTimeStr = r.planTime || '';
      return !isContainerHidden(type, r.containerNo, rLoadDateStr, rPlanTimeStr);
    });
  });
  hiddenPlanContainers = {};
  _localContOverridesDirty = true;
  saveStateToStorage();
  scheduleAutoSaveToCloud('contoverride', [STORAGE_KEY_HIDDEN_CONT], 'Xoá vĩnh viễn container đã ẩn');
  schedulePlanAutoSaveToCloud(); // dữ liệu planData vừa đổi (xoá dòng) cũng cần đẩy lên Cloud, không chỉ mốc hiddenPlanContainers
  renderPlanPanel();
}

// Các dòng được tự thêm vào bảng "Kiểm tồn kho" khi quét QR ra 1 mã+PO không có sẵn tại vị trí đó
// (sai vị trí so với hệ thống) — key theo Kho, value là mảng các dòng tự thêm {item, custpo,
// locator, oqc, qty, isScannedExtra:true}. Cột Locator của các dòng này hiển thị dạng xổ xuống để
// người kiểm có thể chọn lại đúng vị trí nếu cần, mặc định chọn sẵn vị trí hệ thống phát hiện được.
let scannedExtraRows = {};
const STORAGE_KEY_SCANNED_EXTRA = 'tn5_dashboard_scanned_extra_v1';

// Danh sách các GI No. đã quét thành công (chuẩn hoá lowercase) — chặn quét trùng cùng 1 pallet
// nhiều lần (VD: camera vẫn còn thấy mã cũ sau khi đã xử lý xong). Lưu dạng mảng để lưu trữ/đồng bộ
// Cloud, dùng Set để tra cứu nhanh trong lúc chạy.
let scannedGiSet = new Set();
const STORAGE_KEY_SCANNED_GI = 'tn5_dashboard_scanned_gi_v1';

// Nhật ký CHI TIẾT từng lượt quét GI thành công — mảng {gi, kho, item, custpo, locator, oqc, qty,
// rowKey, ts}. scannedGiSet ở trên chỉ biết "GI này đã quét" (chặn quét trùng), KHÔNG biết đã cộng
// vào dòng/vị trí nào — mảng này bù đắp phần đó, phục vụ 2 việc: (1) khi xoá 1 dòng khỏi "Đề xuất
// kiểm hôm nay", tự động xoá luôn các GI đã quét gắn với đúng dòng đó khỏi scannedGiSet (cho quét lại
// được, VD: lỡ quét nhầm sang locator khác quên đổi vị trí); (2) hiện popup "Xem GI đã quét" để đối
// chiếu từng GI theo từng vị trí khi phát hiện thiếu pallet.
let giScanLog = [];
const STORAGE_KEY_GI_LOG = 'tn5_dashboard_gi_scan_log_v1';
// Số dòng tối đa giữ lại trong giScanLog — quét không giới hạn khiến mảng (và JSON lưu mỗi lần quét)
// phình to dần suốt 1 đợt kiểm tồn kho dài; giữ đủ nhiều để "Xem GI đã quét" vẫn hữu ích mà không phình vô hạn.
const GI_SCAN_LOG_MAX = 3000;

// Lịch sử "Danh sách đã xác nhận" theo ngày — bấm nút "Lưu" sẽ chụp lại toàn bộ danh sách đã xác
// nhận hiện tại vào đây (key = ngày dd/mm/yyyy), rồi làm mới (xoá trắng) bảng đã xác nhận để bắt
// đầu đợt kiểm mới. Chỉ giữ tối đa CONFIRMED_HISTORY_MAX_DAYS ngày gần nhất, ngày cũ hơn tự xoá để
// tránh phình dung lượng lưu trữ.
let confirmedHistory = {}; // { 'dd/mm/yyyy': [{kho,item,custpo,locator,oqc,qty,actualResult}, ...] }
const STORAGE_KEY_CONFIRMED_HISTORY = 'tn5_dashboard_confirmed_history_v1';
const CONFIRMED_HISTORY_MAX_DAYS = 5;

// Cho phép chọn thủ công Kho khi hệ thống không tự xác định được (topKho trống, hiện "—") — dạng
// xổ danh sách 3 kho cố định (3B / 3A / 2B). Lưu lại để dùng cho các thống kê/lọc theo Kho khác.
let manualKhoOverrides = {};
const STORAGE_KEY_MANUAL_KHO = 'tn5_dashboard_manual_kho_v1';
const MANUAL_KHO_OPTIONS = ['Kho 3B', 'Kho 3A', 'Kho 2B'];
function setManualKho(type, cNo, loadDate, planTime, khoValue){
  const key = contInstanceKey(type, cNo, loadDate, planTime);
  if(khoValue){
    manualKhoOverrides[key] = khoValue;
  } else {
    delete manualKhoOverrides[key];
  }
  _localContOverridesDirty = true;
  saveStateToStorage();
  scheduleAutoSaveToCloud('contoverride', [STORAGE_KEY_MANUAL_KHO], 'Đổi Kho thủ công');
  renderPlanPanel();
}

let contPickAllRows = [];
// Dữ liệu "Ship" đọc riêng từ file Transaction (Transaction Type = Ship) — dùng để phủ thêm trạng thái
// Đang Load/Đã Load Xong lên bảng Picking Status theo đúng Reference (khớp với cột CR của container).
// Chỉ lưu trong phiên hiện tại (không đồng bộ Cloud/localStorage), không ảnh hưởng tới số liệu KPI.
let contShipData = null; // { byRef: Map<REF, qty>, byRefItem: Map<REF, Map<item, qty>>, fileName, updatedAtText }
const STORAGE_KEY_CONT_SHIP = 'tn5_dashboard_cont_ship_v1';

// Thư viện CBM/đơn vị theo từng mã hàng — gom từ cột CBM trong các Plan đã tải (Row/FC/HCP), tự cập
// nhật mỗi lần tải Plan mới. Khác cột CBM thô trong Plan (tổng CBM của cả lô), đây lưu CBM TÍNH TRÊN 1
// ĐƠN VỊ (cbm/qty) — vốn là thuộc tính vật lý ổn định của mã hàng, dùng lại được lâu dài về sau dù
// không còn Plan chứa mã đó nữa.
let itemCbmLibrary = {}; // { item: { cbm, updatedAt (ISO), source } }
const STORAGE_KEY_ITEM_CBM = 'tn5_dashboard_item_cbm_v1';

// Từ detailRows của 1 Plan vừa tải, tính CBM/đơn vị bình quân gia quyền cho từng mã (gộp mọi PO/cont
// cùng mã trong plan này lại: tổng CBM / tổng SL) — đáng tin hơn lấy đại 1 dòng vì nhiều dòng cùng mã
// có thể lệch làm tròn nhỏ.
function extractItemCbmFromPlanRows(detailRows){
  const sums = {};
  (detailRows || []).forEach(r => {
    const item = normalizeItemCode(r.item || '');
    const qty = Number(r.qty) || 0;
    const cbm = Number(r.cbm);
    if(!item || qty <= 0 || !isFinite(cbm) || cbm <= 0) return;
    if(!sums[item]) sums[item] = { cbmSum: 0, qtySum: 0 };
    sums[item].cbmSum += cbm;
    sums[item].qtySum += qty;
  });
  const result = {};
  Object.entries(sums).forEach(([item, s]) => { if(s.qtySum > 0) result[item] = s.cbmSum / s.qtySum; });
  return result;
}

// Gộp bản CBM mới trích từ 1 Plan vừa tải vào thư viện đang có — mã CHƯA có hoặc gần như giống hệt (≤
// 0.5% lệch, coi là sai số làm tròn) thì tự cập nhật luôn; mã có CBM KHÁC RÕ RỆT với bản đã lưu thì để
// dành hỏi lại người dùng qua popup (itemCbmShowConflictPopup) thay vì âm thầm ghi đè.
function itemCbmMergeFromPlan(newMap, sourceLabel){
  const conflicts = [];
  const now = new Date().toISOString();
  let appliedCount = 0;
  Object.entries(newMap).forEach(([item, cbmPerUnit]) => {
    const existing = itemCbmLibrary[item];
    if(!existing){
      itemCbmLibrary[item] = { cbm: cbmPerUnit, updatedAt: now, source: sourceLabel };
      appliedCount++;
    } else {
      const relDiff = existing.cbm > 0 ? Math.abs(existing.cbm - cbmPerUnit) / existing.cbm : 1;
      if(relDiff > 0.005){
        conflicts.push({ item, oldCbm: existing.cbm, newCbm: cbmPerUnit, oldSource: existing.source, newSource: sourceLabel });
      } else {
        itemCbmLibrary[item] = { cbm: cbmPerUnit, updatedAt: now, source: sourceLabel };
        appliedCount++;
      }
    }
  });
  if(appliedCount){
    saveStateToStorage();
    scheduleAutoSaveToCloud('itemcbm', [STORAGE_KEY_ITEM_CBM], 'Cập nhật thư viện CBM');
  }
  if(conflicts.length) itemCbmShowConflictPopup(conflicts);
}

// Map/Set không tự JSON.stringify được — chuyển qua lại dạng object thường để lưu trữ/đồng bộ Cloud.
function contShipSerialize(data){
  if(!data) return null;
  return {
    fileName: data.fileName, updatedAtText: data.updatedAtText,
    byRef: Object.fromEntries(data.byRef),
    byRefItem: Object.fromEntries([...data.byRefItem].map(([k, v]) => [k, Object.fromEntries(v)])),
    byRefLocators: Object.fromEntries([...(data.byRefLocators || new Map())].map(([k, v]) => [k, [...v]]))
  };
}
function contShipDeserialize(obj){
  if(!obj) return null;
  return {
    fileName: obj.fileName, updatedAtText: obj.updatedAtText,
    byRef: new Map(Object.entries(obj.byRef || {})),
    byRefItem: new Map(Object.entries(obj.byRefItem || {}).map(([k, v]) => [k, new Map(Object.entries(v))])),
    byRefLocators: new Map(Object.entries(obj.byRefLocators || {}).map(([k, v]) => [k, new Set(v)]))
  };
}

function contShipBuildFromRecords(records){
  const byRef = new Map();
  const byRefItem = new Map();
  const byRefLocators = new Map(); // ref -> Set(locator) — để suy ra Kho nào đang/đã Load
  records.forEach(r => {
    if(String(r.transType || '').trim().toUpperCase() !== 'SHIP') return;
    // Chuẩn hoá Reference: cắt khoảng trắng 2 đầu + bỏ dấu câu thừa ở CUỐI (dấu ; , . thấy xuất hiện
    // trong dữ liệu gốc, VD: "CR0165293;") — không cắt dấu câu ở giữa để không làm sai các Reference
    // hợp lệ có ký tự đặc biệt thật sự ở giữa.
    const ref = String(r.reference || '').trim().toUpperCase().replace(/[;,.\s]+$/, '');
    if(!ref) return;
    // SL Ship trong file gốc ghi ÂM (hàng đang rời khỏi kho, cùng quy ước với các dòng SL âm ở vị trí
    // XUẤT của Move Pallet/Transfer) — phải lấy trị tuyệt đối mới cộng dồn và so sánh % với Plan được,
    // nếu không tổng luôn âm nên không bao giờ > 0% để đổi trạng thái.
    const qty = Math.abs(r.qty || 0);
    byRef.set(ref, (byRef.get(ref) || 0) + qty);
    if(!byRefItem.has(ref)) byRefItem.set(ref, new Map());
    const im = byRefItem.get(ref);
    im.set(r.item, (im.get(r.item) || 0) + qty);
    if(r.locator){
      if(!byRefLocators.has(ref)) byRefLocators.set(ref, new Set());
      byRefLocators.get(ref).add(r.locator);
    }
  });
  return { byRef, byRefItem, byRefLocators };
}

// Suy ra danh sách Kho (VD: "Kho 2B", "Kho 2B + Kho 3A") từ tập hợp Locator Name gom được của các
// Reference vừa khớp — dùng đúng logic đoán Kho theo tiền tố locator đã có sẵn (resolveKhoForLocator).
function contShipKhoLabelForRefs(refs, byRefLocators){
  const khoSet = new Set();
  const lookupMap = buildLocatorKhoMap();
  refs.forEach(ref => {
    const locs = byRefLocators.get(ref);
    if(!locs) return;
    locs.forEach(loc => {
      const kho = resolveKhoForLocator(loc, lookupMap);
      if(kho && kho !== '—') khoSet.add(kho);
    });
  });
  if(!khoSet.size) return '';
  return [...khoSet].sort().map(k => `Kho ${k}`).join(' + ');
}

// Trả về ĐÚNG 1 "Kho X" nếu dữ liệu Ship xác định được rõ ràng container này load từ đúng 1 kho — trả
// về null nếu không có dữ liệu Ship khớp, hoặc dữ liệu Ship cho thấy nhiều hơn 1 kho (không đủ rõ ràng
// để tự đổi). Dùng để tự chọn lại cột "Kho" theo bằng chứng THẬT (đã load ở đâu) thay vì chỉ đoán theo
// SL tồn nhiều nhất.
function contShipDetectSingleKho(csrsSet){
  if(!contShipData || !contShipData.byRef.size || !csrsSet || !csrsSet.size) return null;
  const refs = [];
  csrsSet.forEach(csr => {
    const ref = String(csr || '').trim().toUpperCase().replace(/[;,.\s]+$/, '');
    if(contShipData.byRef.has(ref)) refs.push(ref);
  });
  if(!refs.length) return null;
  const khoLabel = contShipKhoLabelForRefs(refs, contShipData.byRefLocators);
  if(!khoLabel || khoLabel.includes('+')) return null;
  return khoLabel;
}

// Đếm số CR trong bảng Picking Status thực sự khớp được với Reference trong dữ liệu Ship vừa tải —
// dùng để báo đúng số lượng khớp THẬT (khác với byRef.size chỉ là số Reference có trong file Ship,
// có thể không trùng CR nào trong Plan hiện tại).
function contShipCountMatchedContainers(byRef){
  const matchedRefs = new Set();
  (contPickAllRows || []).forEach(row => {
    String(row.csr || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean).forEach(ref => {
      if(byRef.has(ref)) matchedRefs.add(ref);
    });
  });
  return matchedRefs.size;
}

// Container này đã Load Xong 100% (theo dữ liệu Ship vừa tải) chưa — dùng để TỰ ĐỘNG tính là "Pick
// xong" trong KPI/Trạng thái mà không cần tick tay, vì đã chất hết hàng lên xe/cont thì chắc chắn đã
// pick xong khỏi kho rồi (Ship luôn xảy ra SAU Pick). csrsSet là Set các CR (entry.csrs).
function contShipIsFullyLoaded(csrsSet, planQty){
  if(!contShipData || !contShipData.byRef.size || !csrsSet || !csrsSet.size) return false;
  let shipQty = 0, matched = false;
  csrsSet.forEach(csr => {
    const ref = String(csr || '').trim().toUpperCase().replace(/[;,.\s]+$/, '');
    if(contShipData.byRef.has(ref)){ matched = true; shipQty += contShipData.byRef.get(ref); }
  });
  if(!matched) return false;
  const pct = planQty > 0 ? (shipQty / planQty * 100) : 0;
  return pct >= 99.995;
}
let contPickColFilters = {}; // col -> Set giá trị được chọn (không có key = không lọc cột đó)
let contPickSort = { col: null, dir: 1 };

function cptColLabel(row, col){
  if(col === 'status') return CONT_PICK_STATUS_LABEL[row.status] || row.status;
  if(col === 'cNo') return String(row.cNo);
  return row[col] || '';
}

function applyContPickFilters(rows){
  const activeCols = Object.keys(contPickColFilters).filter(c => contPickColFilters[c]);
  if(!activeCols.length) return rows;
  return rows.filter(row => activeCols.every(col => contPickColFilters[col].has(cptColLabel(row, col))));
}

function sortContPickRows(rows){
  const { col, dir } = contPickSort;
  const arr = rows.slice();
  if(!col){
    // Mặc định: sắp theo ngày giờ load tăng dần (sớm nhất lên đầu) — container chưa rõ ngày/giờ xuống cuối.
    arr.sort((a, b) => ovParseDateTimeSortKey(a.loadDate, a.planTime) - ovParseDateTimeSortKey(b.loadDate, b.planTime));
    return arr;
  }
  arr.sort((a, b) => {
    if(col === 'pct') return (a.pct - b.pct) * dir;
    if(col === 'status') return (CONT_PICK_STATUS_ORDER[a.status] - CONT_PICK_STATUS_ORDER[b.status]) * dir;
    if(col === 'cNo') return String(a.cNo).localeCompare(String(b.cNo), 'vi', { numeric: true }) * dir;
    if(col === 'loadDate' || col === 'planTime') return (ovParseDateTimeSortKey(a.loadDate, a.planTime) - ovParseDateTimeSortKey(b.loadDate, b.planTime)) * dir;
    return String(a[col] || '').localeCompare(String(b[col] || ''), 'vi', { numeric: true }) * dir;
  });
  return arr;
}

function renderContPickTable(){
  const detailTbody = document.getElementById('cont-picking-detail-tbody');
  if(!detailTbody) return;

  const rows = sortContPickRows(applyContPickFilters(contPickAllRows));
  contPickRowsCache = rows;

  if(!rows.length){
    detailTbody.innerHTML = `<tr><td colspan="11" style="text-align:center; color:var(--muted-2); padding:16px; font-style:italic;">Không có dòng nào khớp với bộ lọc</td></tr>`;
  } else {
    detailTbody.innerHTML = rows.map((row, idx) => {
      const hasShort = row.shortItems && row.shortItems.length > 0;
      const shortBadge = hasShort
        ? `<button type="button" class="cpt-short-badge" data-jump-combined="${escAttr(combinedRowDomId(row.shortItems[0].item, row.shortItems[0].po))}" title="Thiếu ${row.shortItems.length} mã (tính riêng container này): ${row.shortItems.map(r=>`${r.item} (thiếu ${fmt(-r.diff)})`).join(', ')} — bấm để xem chi tiết mã hàng">⚠ Thiếu ${row.shortItems.length}</button>`
        : '';
      // Cờ container MỚI xuất hiện / vừa đổi Ngày Load-Giờ Plan so với lần tải Plan trước — xem
      // computePlanContainerChanges(). Tự mất khi tải Plan lần kế tiếp (không cần bấm tắt thủ công).
      const changeBadge = row.changeStatus === 'new'
        ? `<span class="cpt-change-badge cpt-change-new" title="Container này MỚI xuất hiện so với lần tải Plan ${row.type} gần nhất trước đó">✨ Mới</span>`
        : row.changeStatus === 'changed'
          ? `<span class="cpt-change-badge cpt-change-changed" title="Ngày Load / Giờ Plan của container này vừa đổi so với lần tải Plan ${row.type} gần nhất trước đó">⟳ Đổi giờ</span>`
          : '';
      const khoCell = `<select class="cpt-kho-manual-select${row.isManualKho ? ' is-manual' : ''}" data-manual-type="${escAttr(row.type)}" data-manual-cno="${escAttr(String(row.cNo))}" data-manual-loaddate="${escAttr(row.loadDateKey || '')}" data-manual-plantime="${escAttr(row.planTimeKey || '')}" title="${row.isManualKho ? 'Đang chọn thủ công — bấm để đổi lại' : 'Kho hệ thống tự xác định — bấm để chọn lại thủ công nếu cần'}">
             <option value="">—</option>
             ${MANUAL_KHO_OPTIONS.map(k => `<option value="${escAttr(k)}"${row.topKho===k ? ' selected' : ''}>${escHtml(k.replace('Kho ',''))}</option>`).join('')}
           </select>`;

      // Trạng thái LOADING — cột RIÊNG, tách biệt hoàn toàn khỏi cột "Trạng thái" (Picking Status) để
      // không gây nhầm lẫn giữa 2 việc khác nhau: pick xong hàng trong kho, và đã chất lên xe/cont hay
      // chưa. Chỉ có giá trị khi đã tải file Ship VÀ Reference khớp đúng CR của container này.
      let loadingHtml = '<span style="color:var(--muted-2);">—</span>';
      if(contShipData && contShipData.byRef.size){
        const refs = String(row.csr || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
        let shipQty = 0, matched = false;
        const matchedRefs = [];
        refs.forEach(ref => { if(contShipData.byRef.has(ref)){ matched = true; shipQty += contShipData.byRef.get(ref); matchedRefs.push(ref); } });
        if(matched && shipQty > 0){
          const shipPct = row.planQty > 0 ? (shipQty / row.planQty * 100) : 0;
          const khoLabel = contShipKhoLabelForRefs(matchedRefs, contShipData.byRefLocators);
          const khoSuffix = khoLabel ? ` <span style="color:var(--muted-2); font-weight:400;">· ${escHtml(khoLabel)}</span>` : '';
          if(shipPct >= 99.995) loadingHtml = `<span style="color:var(--teal); font-weight:600;">Đã Load Xong</span>${khoSuffix}`;
          else loadingHtml = `<span style="color:var(--amber-bright); font-weight:600;">Đang Load (${shipPct.toFixed(0)}%)</span>${khoSuffix}`;
        }
      }
      return `
      <tr class="cont-pick-row${row.isManual ? ' cpt-row-manual' : ''}" style="cursor:pointer;" data-row-idx="${idx}" data-cont-jump="${contDomId(row.type, row.cNo)}">
        <td>${row.type}</td>
        <td>${changeBadge}${escHtml(String(row.cNo))}
          ${shortBadge}
        </td>
        <td>${escHtml(row.loadDate)}</td>
        <td>${escHtml(row.planTime)}</td>
        <td>${escHtml(row.invoice)}
          <button type="button" class="cpt-pick-slip-btn" data-pick-type="${escAttr(row.type)}" data-pick-cno="${escAttr(String(row.cNo))}" data-pick-instance="${escAttr(row.instanceKey)}" title="Xem gợi ý pick hàng cho container này">🖨</button>
        </td>
        <td>${escHtml(row.csr)}</td>
        <td>${khoCell}</td>
        <td class="num">
          <div class="picking-bar-wrap" style="min-width:70px;">
            <div class="picking-bar-track"><div class="picking-bar-fill" style="width:${row.pct}%; background:${row.pct >= 100 ? 'var(--teal)' : (row.pct >= 50 ? 'var(--amber-bright)' : 'var(--red)')};"></div></div>
            <span class="picking-bar-label">${row.pct.toFixed(0)}%</span>
          </div>
        </td>
        <td>
          <span style="color:${CONT_PICK_STATUS_COLOR[row.status]}; font-weight:600;">${CONT_PICK_STATUS_LABEL[row.status]}</span>
          <button type="button" class="cpt-mark-btn${row.isManual ? ' marked' : ''}" data-mark-type="${escAttr(row.type)}" data-mark-cno="${escAttr(String(row.cNo))}" data-mark-loaddate="${escAttr(row.loadDateKey || '')}" data-mark-plantime="${escAttr(row.planTimeKey || '')}" title="${row.isManual ? 'Bỏ đánh dấu thủ công' : 'Đánh dấu thủ công là đã pick xong — không đụng tới số liệu tồn kho'}">${row.isManual ? '↺' : '✓'}</button>
          <button type="button" class="cpt-delete-btn" data-delete-type="${escAttr(row.type)}" data-delete-cno="${escAttr(String(row.cNo))}" data-delete-loaddate="${escAttr(row.loadDateKey || '')}" data-delete-plantime="${escAttr(row.planTimeKey || '')}" title="Xoá container này khỏi Plan (chỉ ẩn khỏi dashboard, không sửa file Excel gốc — sẽ hỏi xác nhận trước)">🗑</button>
        </td>
        <td>${loadingHtml}</td>
        <td><input type="text" class="cpt-comment-input" data-instance="${escAttr(row.instanceKey)}" value="${escAttr(row.comment || '')}" placeholder="Tự điền ghi chú…" style="width:100%; box-sizing:border-box; border:1px solid var(--line); border-radius:6px; padding:4px 7px; font-family:var(--mono); font-size:11.5px; background:var(--panel); color:var(--text);"></td>
      </tr>`;
    }).join('');
  }

  document.querySelectorAll('.cpt-sort-btn').forEach(btn => {
    const active = btn.dataset.sort === contPickSort.col;
    btn.classList.toggle('active', active);
    btn.textContent = active ? (contPickSort.dir === 1 ? '↑' : '↓') : '⇅';
  });
  document.querySelectorAll('.cpt-filter-btn').forEach(btn => {
    btn.classList.toggle('active', !!contPickColFilters[btn.dataset.col]);
  });
}

// Bảng "Cont theo Kho" — 3 cột Kho 3B / Kho 3A / Kho 2B (đúng thứ tự yêu cầu), mỗi cột hiện số
// lượng container cần đóng ở kho đó + trạng thái pick (chưa/đang/xong) RIÊNG của kho đó. Dựa trên
// bảng thống kê container (contPickAllRows) — dùng đúng field topKho (kho có SL tồn nhiều nhất cho
// các mã hàng của container đó). Cont nào không xác định được kho hiện badge nhỏ riêng, không chiếm
// hẳn 1 cột. Nhấn vào cả bảng để nhảy xuống bảng thống kê chi tiết container.
function scrollToContPickingOverview(){
  const jumpAndScroll = () => {
    const target = document.getElementById('cont-picking-overview');
    if(!target || target.style.display === 'none') return;
    if(typeof alertsHighlightScroll === 'function') alertsHighlightScroll(target);
    else target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  // Bảng thống kê container nằm ở trang "Picking Status" (#page-picking) — khác trang với bảng
  // tổng hợp này (#page-overview) — nên phải chuyển trang trước rồi mới cuộn tới.
  if(typeof alertsJumpTo === 'function') alertsJumpTo('picking', jumpAndScroll);
  else jumpAndScroll();
}

function renderKhoContSummary(detailRows){
  const kpiStripEl = document.getElementById('kpi-strip');
  if(!kpiStripEl) return;
  if(!detailRows || !detailRows.length){
    kpiStripEl.innerHTML = `<div style="padding:16px 18px;"><div class="kcs-kho-name">CONT THEO KHO</div><div class="kcs-total">—</div><div class="kcs-total-label">Chưa có dữ liệu Plan container để thống kê</div></div>`;
    return;
  }
  const khoOrder = ['Kho 3B', 'Kho 3A', 'Kho 2B'];
  const isDone = r => r.status === 'done' || r.status === 'manualDone';
  const unclassified = detailRows.filter(r => !r.topKho || !khoOrder.includes(r.topKho)).length;

  const unclassifiedHtml = unclassified
    ? `<div class="kcs-unclassified">⚠ ${fmt(unclassified)} container chưa xác định được kho</div>`
    : '';

  const colsHtml = khoOrder.map(kho => {
    const rows = detailRows.filter(r => r.topKho === kho);
    const notStarted = rows.filter(r => r.status === 'notStarted').length;
    const inProgress = rows.filter(r => r.status === 'inProgress').length;
    const done = rows.filter(isDone).length;
    return `<div class="kcs-col">
      <div class="kcs-kho-name">${escHtml(kho.replace('Kho ', 'KHO '))}</div>
      <div class="kcs-total">${fmt(rows.length)}</div>
      <div class="kcs-total-label">container cần đóng</div>
      <div class="kcs-status-row"><span class="kcs-dot bad"></span>Chưa pick<b>${fmt(notStarted)}</b></div>
      <div class="kcs-status-row"><span class="kcs-dot accent"></span>Đang pick<b>${fmt(inProgress)}</b></div>
      <div class="kcs-status-row"><span class="kcs-dot good"></span>Pick xong<b>${fmt(done)}</b></div>
    </div>`;
  }).join('');

  kpiStripEl.innerHTML = `
    ${unclassifiedHtml}
    <div class="kcs-grid">${colsHtml}</div>
    <div class="kcs-hint">Nhấn để xem bảng thống kê chi tiết container ↓</div>
  `;
}

// Thanh hiển thị các container đã bị xoá/ẩn khỏi Plan — cho phép khôi phục lại bất cứ lúc nào.
function renderHiddenContBar(){
  const el = document.getElementById('cont-picking-hidden-bar');
  if(!el) return;
  const keys = Object.keys(hiddenPlanContainers);
  if(!keys.length){ el.innerHTML = ''; return; }
  const chips = keys.map(k => {
    const h = hiddenPlanContainers[k];
    const loadInfo = (h.loadDate || h.planTime) ? ` <span style="opacity:.7;">(${escHtml(h.loadDate || '—')}${h.planTime ? ' ' + escHtml(h.planTime) : ''})</span>` : '';
    return `<span class="cpt-hidden-cont-chip">${escHtml(h.type)}-${escHtml(String(h.cNo))}${loadInfo}
      <button type="button" class="cpt-hidden-cont-restore" data-restore-type="${escAttr(h.type)}" data-restore-cno="${escAttr(String(h.cNo))}" data-restore-loaddate="${escAttr(h.loadDate || '')}" data-restore-plantime="${escAttr(h.planTime || '')}" title="Khôi phục container này vào bảng Plan">↺ Khôi phục</button>
    </span>`;
  }).join('');
  el.innerHTML = `
    <div class="cpt-hidden-cont-wrap">
      <button type="button" class="cpt-hidden-cont-toggle" id="cpt-hidden-cont-toggle" title="Xem các container đã ẩn khỏi Plan">
        🗑 Cont đã ẩn <span class="cpt-hidden-cont-count">${fmt(keys.length)}</span>
      </button>
      <button type="button" class="cpt-hidden-cont-delete-all" id="cpt-hidden-cont-delete-all" title="Xoá VĨNH VIỄN dữ liệu tất cả container đã ẩn — không thể khôi phục lại">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>
      </button>
      <div class="cpt-hidden-cont-popup" id="cpt-hidden-cont-popup" style="display:none;">
        <div class="cpt-hidden-cont-popup-title">Đã ẩn ${fmt(keys.length)} container khỏi Plan (không đụng file Excel gốc):</div>
        <div class="cpt-hidden-cont-popup-list">${chips}</div>
      </div>
    </div>`;
}
document.addEventListener('click', (e) => {
  const toggle = e.target.closest('#cpt-hidden-cont-toggle');
  const deleteAllBtn = e.target.closest('#cpt-hidden-cont-delete-all');
  const popup = document.getElementById('cpt-hidden-cont-popup');
  if(toggle){
    if(popup) popup.style.display = popup.style.display === 'none' ? 'block' : 'none';
    return;
  }
  if(deleteAllBtn){
    deleteAllHiddenContainerData();
    return;
  }
  // Bấm ra ngoài popup thì đóng lại (trừ khi đang bấm nút khôi phục bên trong popup)
  if(popup && popup.style.display !== 'none' && !e.target.closest('#cpt-hidden-cont-popup')){
    popup.style.display = 'none';
  }
});

function renderContainerPickingOverview(){
  const panelEl = document.getElementById('cont-picking-overview');
  const kpiEl = document.getElementById('cont-picking-kpi-strip');
  const detailWrap = document.getElementById('cont-picking-detail-wrap');
  const detailTbody = document.getElementById('cont-picking-detail-tbody');
  if(!panelEl || !kpiEl) return;

  const loadedTypes = PLAN_TYPES.filter(t => planData[t]);
  if(!loadedTypes.length){
    panelEl.style.display = 'none';
    kpiEl.innerHTML = '';
    if(detailWrap) detailWrap.style.display = 'none';
    if(detailTbody) detailTbody.innerHTML = '';
    contPickAllRows = [];
    renderKhoContSummary([]);
    renderHiddenContBar();
    return;
  }

  const pickingIdx = buildPickingIndex(currentData);
  // key = type|contNo|loadDate|planTime -> { type, cNo, loadDate, planTime, planQty, contribution, invoices:Set, csrs:Set }
  // QUAN TRỌNG: khoá GỘP theo cả Ngày Load + Giờ Plan, KHÔNG chỉ theo số cont — vì cùng 1 số cont có
  // thể là 2 lượt xuất khác nhau (ngày/giờ khác nhau) và phải được coi là 2 container RIÊNG BIỆT,
  // không gộp SL kế hoạch / trạng thái pick của 2 lượt đó làm một.
  const contMap = new Map();

  loadedTypes.forEach(type => {
    const rows = (planData[type].detailRows) || [];
    rows.forEach(r => {
      const cNo = r.containerNo;
      if(!cNo || cNo === '—') return;
      const loadDateStr = r.loadDate ? fmtDate(r.loadDate) : '';
      const planTimeStr = r.planTime || '';
      const key = contInstanceKey(type, cNo, loadDateStr, planTimeStr);
      const itemKey = (r.item || '').toLowerCase();
      const csrKey = (r.csr || '').trim().toLowerCase();
      let passQty = 0;
      if(csrKey){
        const lookupKey = itemKey + '|' + csrKey;
        passQty = pickingIdx[lookupKey] || 0;
      }
      const planQty = r.qty || 0;
      let contribution = planQty > 0 ? Math.min(passQty, planQty) : 0;
      // Mã SPP (không có GI nên không thể tự tính qua CSR/PASS) đã được tick "Đủ hàng" thủ công
      // -> coi như đã pick đủ phần kế hoạch của mã này, để % Picking Status của container nhảy theo.
      // SỬA (lỗi thật đã gặp): khi Cust PO rỗng, popup Nhóm SPP chuẩn hoá key thành '(Khong co)'
      // (xem buildCombinedPlanCompareTable) trước khi lưu tick — ở đây trước kia dùng thẳng r.custPo
      // (chuỗi RỖNG, không chuẩn hoá) nên 2 khoá lệch nhau, tick tay không bao giờ khớp, % vẫn đứng
      // yên ở 0%. Chuẩn hoá y hệt ngay khi tra cứu (giống shortItems bên dưới đã làm đúng).
      const custPoForSppKey = (r.custPo && r.custPo.trim()) ? r.custPo.trim() : '(Khong co)';
      if(ccIsSppItem(r.item) && sppManualOk[sppOkKey(r.item, custPoForSppKey)]){
        contribution = planQty;
      }
      let entry = contMap.get(key);
      if(!entry){ entry = { type, cNo, loadDate: loadDateStr, planTime: planTimeStr, planQty: 0, contribution: 0, invoices: new Set(), csrs: new Set(), loadDates: new Set(), planTimes: new Set(), items: new Map() }; contMap.set(key, entry); }
      entry.planQty += planQty;
      entry.contribution += contribution;
      if(r.invoice) entry.invoices.add(r.invoice);
      if(r.csr) entry.csrs.add(r.csr);
      if(r.loadDate) entry.loadDates.add(fmtDate(r.loadDate));
      if(r.planTime) entry.planTimes.add(r.planTime);
      const itemPoKey = r.item + '||' + (r.custPo || '');
      if(!entry.items.has(itemPoKey)) entry.items.set(itemPoKey, { item: r.item, po: r.custPo || '', qty: 0, cbm: 0 });
      entry.items.get(itemPoKey).qty += planQty;
      entry.items.get(itemPoKey).cbm += (parseFloat(r.cbm) || 0);
    });
  });

  let notStarted = 0, inProgress = 0, done = 0, total = 0;
  const detailRows = [];
  contMap.forEach(entry => {
    if(entry.planQty <= 0) return;
    const instanceKey = contInstanceKey(entry.type, entry.cNo, entry.loadDate, entry.planTime);
    if(hiddenPlanContainers[instanceKey]) return; // đã bị xoá/ẩn thủ công khỏi Plan (đúng lượt xuất này)
    total++;
    const pct = (entry.contribution / entry.planQty) * 100;
    // Trạng thái TỰ TÍNH theo tồn kho thực tế — KHÔNG bị đánh dấu thủ công làm sai lệch, vẫn giữ
    // nguyên để mọi chỗ khác (so sánh Plan, cảnh báo...) luôn dùng đúng số liệu tồn kho thật.
    let autoStatus;
    if(pct >= 99.995) autoStatus = 'done';
    else if(pct <= 0.005) autoStatus = 'notStarted';
    else autoStatus = 'inProgress';

    // Đánh dấu THỦ CÔNG (nếu có) — chỉ đổi NHÃN/TRẠNG THÁI HIỂN THỊ cho nhân viên dễ theo dõi,
    // hoàn toàn không đụng tới pct/contribution hay bất kỳ số liệu tồn kho nào ở trên.
    const manualKey = instanceKey;
    const isManualUser = !!(manualPickedContainers && manualPickedContainers[manualKey]);
    // Container đã Load Xong 100% theo dữ liệu Ship -> TỰ ĐỘNG tính là Pick xong (không cần tick tay),
    // vì chất hàng lên xe/cont chỉ xảy ra SAU khi đã pick xong khỏi kho.
    const isShipDone = !isManualUser && contShipIsFullyLoaded(entry.csrs, entry.planQty);
    const isManual = isManualUser || isShipDone;
    const status = isManual ? 'manualDone' : autoStatus;
    if(status === 'manualDone' || status === 'done') done++;
    else if(status === 'notStarted') notStarted++;
    else inProgress++;

    const items = [...entry.items.values()].map(it => {
      // Loại vị trí "Prod" khỏi tồn kho khả dụng — đây là khu trung chuyển/sản xuất, không tính là
      // hàng sẵn sàng để pick xuất cont.
      const locs = buildItemLocatorDetail(it.item, it.po, true);
      const totalOnHand = locs.reduce((s, l) => s + l.qty, 0);
      const passOnHand = locs.reduce((s, l) => s + (l.oqc === 'PASS' ? l.qty : 0), 0);
      return { item: it.item, po: it.po, qty: it.qty, cbm: it.cbm, locs, totalOnHand, passOnHand };
    });

    // Mã hàng nào "Thiếu" TÍNH RIÊNG cho container này (không gộp với container khác dùng chung mã):
    // so SL kế hoạch của CHÍNH container này với SL tồn kho PASS hiện có của mã đó. Container ĐÃ Pick
    // xong (thủ công hoặc đã Load Xong theo Ship) thì KHÔNG còn cần lấy thêm gì nữa — bỏ qua cảnh báo
    // Thiếu, tránh báo nhầm do tồn kho hiện tại đã giảm (vì chính lô hàng này vừa được lấy/xuất đi).
    //
    // LỖI THẬT ĐÃ GẶP (mã SPP đã tick "Đủ hàng" ở popup Nhóm SPP nhưng ở đây vẫn báo Thiếu): khi mã
    // hàng không có Cust PO, popup Nhóm SPP (buildCombinedPlanCompareTable) chuẩn hoá thành chuỗi
    // '(Khong co)' rồi mới ghép khoá sppOkKey — còn ở đây "it.po" lấy thẳng r.custPo || '' (chuỗi
    // RỖNG, không qua chuẩn hoá) — 2 khoá lệch nhau ('...␟(khong co)' vs '...␟') nên tick tay không
    // bao giờ khớp được. Chuẩn hoá lại y hệt (it.po || '(Khong co)') ngay khi tra cứu, KHÔNG đổi giá
    // trị "po" gốc đang lưu trong shortItems (dòng map bên dưới vẫn giữ nguyên "po" thật để tính năng
    // "bấm để xem chi tiết mã hàng" nhảy đúng dòng — combinedRowDomId() lại cần "po" RỖNG mới khớp).
    const shortItems = isManual ? [] : items
      .filter(it => it.qty > it.passOnHand && !(ccIsSppItem(it.item) && sppManualOk[sppOkKey(it.item, it.po || '(Khong co)')]))
      .map(it => ({ item: it.item, po: it.po, qty: it.qty, passOnHand: it.passOnHand, diff: it.passOnHand - it.qty }));

    // Kho có SL tồn (PASS+NG, gộp mọi vị trí) nhiều nhất cho các mã hàng của container này
    const qtyByKho = {};
    items.forEach(it => it.locs.forEach(l => { qtyByKho[l.kho] = (qtyByKho[l.kho] || 0) + l.qty; }));
    let topKho = null, topKhoQty = 0;
    Object.entries(qtyByKho).forEach(([kho, qty]) => { if(qty > topKhoQty){ topKho = kho; topKhoQty = qty; } });

    // Lựa chọn thủ công LUÔN được ưu tiên áp dụng (ghi đè Kho hệ thống tự xác định được) — không chỉ
    // dùng khi hệ thống không tự xác định được như trước, vì giờ cột Kho cho chọn tay ở MỌI dòng.
    let isManualKho = false;
    if(manualKhoOverrides[manualKey]){
      topKho = manualKhoOverrides[manualKey];
      topKhoQty = qtyByKho[topKho] || 0;
      isManualKho = true;
    } else {
      // Chưa ai chọn tay -> nếu dữ liệu Ship xác định rõ ràng ĐÚNG 1 kho đã thực sự load hàng cho
      // container này mà KHÁC với kho đang tự đoán theo SL tồn nhiều nhất, tự đổi sang đúng kho đó —
      // bằng chứng THẬT (đã load ở đâu) đáng tin hơn suy đoán theo số lượng tồn.
      const shipKho = contShipDetectSingleKho(entry.csrs);
      if(shipKho && shipKho !== topKho){
        topKho = shipKho;
        topKhoQty = qtyByKho[topKho] || 0;
      }
    }

    // Cờ MỚI xuất hiện / vừa đổi Ngày Load-Giờ Plan (xem computePlanContainerChanges(), tính ngay lúc
    // tải file Plan) — instanceKey ở đây ĐÚNG bằng contInstanceKey() dùng để lưu cờ đó.
    const changeInfo = planContainerChangeInfo[instanceKey];
    detailRows.push({
      type: entry.type, cNo: entry.cNo, pct, status, autoStatus, autoPct: pct, isManual,
      changeStatus: changeInfo ? changeInfo.status : null,
      comment: contPickComments[instanceKey] || '',
      instanceKey, planQty: entry.planQty,
      loadDateKey: entry.loadDate, planTimeKey: entry.planTime,
      loadDate: [...entry.loadDates].join(', ') || '—',
      planTime: [...entry.planTimes].join(', ') || '—',
      invoice: [...entry.invoices].join(', ') || '—',
      csr: [...entry.csrs].join(', ') || '—',
      items, shortItems, topKho, topKhoQty, isManualKho
    });
  });

  if(!total){
    panelEl.style.display = 'none';
    kpiEl.innerHTML = '';
    if(detailWrap) detailWrap.style.display = 'none';
    if(detailTbody) detailTbody.innerHTML = '';
    contPickAllRows = [];
    renderKhoContSummary([]);
    renderHiddenContBar();
    return;
  }

  panelEl.style.display = '';
  kpiEl.innerHTML = `
    <div class="kpi"><div class="label">TỔNG CONTAINER</div><div class="value">${fmt(total)}</div><div class="foot">Có gán số container trong Plan đã tải</div></div>
    <div class="kpi bad"><div class="label">CHƯA PICK</div><div class="value">${fmt(notStarted)}</div><div class="foot">Picking Status = 0%</div></div>
    <div class="kpi accent"><div class="label">ĐANG PICK</div><div class="value">${fmt(inProgress)}</div><div class="foot">Picking Status &gt; 0% và &lt; 100%</div></div>
    <div class="kpi good"><div class="label">PICK XONG</div><div class="value">${fmt(done)}</div><div class="foot">Picking Status = 100% hoặc đã đánh dấu thủ công</div></div>
  `;
  renderHiddenContBar();

  if(detailWrap){
    contPickAllRows = detailRows;
    renderContPickTable();
    detailWrap.style.display = '';
  }
  renderKhoContSummary(detailRows);
}

let cptActiveFilterDropdown = null; // {col, el}
function cptCloseFilterDropdown(){
  if(cptActiveFilterDropdown){ cptActiveFilterDropdown.el.remove(); cptActiveFilterDropdown = null; }
  document.removeEventListener('mousedown', cptFilterDropdownOutsideHandler, true);
}
function cptFilterDropdownOutsideHandler(e){
  if(cptActiveFilterDropdown && !cptActiveFilterDropdown.el.contains(e.target)) cptCloseFilterDropdown();
}
function cptGetColumnValues(col){
  const set = new Set();
  contPickAllRows.forEach(row => { const v = cptColLabel(row, col); if(v) set.add(v); });
  return Array.from(set).sort((a,b) => a.localeCompare(b, 'vi', { numeric: true }));
}
function cptToggleColumnFilterDropdown(col, btn){
  if(cptActiveFilterDropdown && cptActiveFilterDropdown.col === col){
    cptCloseFilterDropdown();
    return;
  }
  cptCloseFilterDropdown();
  const values = cptGetColumnValues(col);
  const currentSet = contPickColFilters[col];
  const rect = btn.getBoundingClientRect();
  const panel = document.createElement('div');
  panel.className = 'tx-filter-dropdown';
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - 260));
  panel.style.cssText = `position:fixed; top:${rect.bottom+4}px; left:${left}px; width:240px; max-height:340px; overflow:auto; background:#fff; border:1px solid var(--line); border-radius:10px; box-shadow:0 12px 32px rgba(0,0,0,0.18); z-index:9999; padding:10px; font-family:var(--mono);`;

  const isAllSelected = !currentSet;
  const checklistHtml = values.map(v => {
    const checked = isAllSelected || currentSet.has(v);
    return `<label style="display:flex; align-items:center; gap:8px; padding:5px 4px; font-size:12.5px; cursor:pointer; border-radius:6px;">
      <input type="checkbox" class="tx-filter-chk" value="${escAttr(v)}" ${checked ? 'checked' : ''}>
      <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escHtml(v)}</span>
    </label>`;
  }).join('') || '<div style="font-size:12px; color:var(--muted); padding:6px 2px;">Không có giá trị</div>';

  panel.innerHTML = `
    <input type="text" class="tx-filter-search-inner" placeholder="Tìm giá trị…" style="width:100%; box-sizing:border-box; border:1px solid var(--line); border-radius:6px; padding:7px 9px; font-size:12.5px; margin-bottom:8px; outline:none;">
    <div style="display:flex; gap:12px; margin-bottom:6px;">
      <button type="button" class="tx-filter-selall" style="font-size:11.5px; border:none; background:none; color:var(--blue); cursor:pointer; padding:0;">Chọn tất cả</button>
      <button type="button" class="tx-filter-clrall" style="font-size:11.5px; border:none; background:none; color:var(--blue); cursor:pointer; padding:0;">Bỏ chọn</button>
    </div>
    <div class="tx-filter-list">${checklistHtml}</div>
    <div style="display:flex; gap:8px; margin-top:10px; border-top:1px solid var(--line); padding-top:8px;">
      <button type="button" class="tx-filter-apply btn-update" style="flex:1; padding:6px 8px; font-size:12px; justify-content:center;">Áp dụng</button>
      <button type="button" class="tx-filter-reset btn-update btn-danger" style="flex:1; padding:6px 8px; font-size:12px; justify-content:center;">Xoá lọc</button>
    </div>
  `;
  document.body.appendChild(panel);
  cptActiveFilterDropdown = { col, el: panel };
  setTimeout(() => document.addEventListener('mousedown', cptFilterDropdownOutsideHandler, true), 0);

  const searchInner = panel.querySelector('.tx-filter-search-inner');
  searchInner.focus();
  searchInner.addEventListener('input', () => {
    const q = removeDiacritics(searchInner.value.toLowerCase().trim());
    panel.querySelectorAll('.tx-filter-list label').forEach(lbl => {
      const text = removeDiacritics(lbl.textContent.toLowerCase());
      lbl.style.display = text.includes(q) ? 'flex' : 'none';
    });
  });
  panel.querySelector('.tx-filter-selall').addEventListener('click', () => {
    panel.querySelectorAll('.tx-filter-list label').forEach(lbl => {
      if(lbl.style.display !== 'none'){ const c = lbl.querySelector('.tx-filter-chk'); if(c) c.checked = true; }
    });
  });
  panel.querySelector('.tx-filter-clrall').addEventListener('click', () => {
    panel.querySelectorAll('.tx-filter-list label').forEach(lbl => {
      if(lbl.style.display !== 'none'){ const c = lbl.querySelector('.tx-filter-chk'); if(c) c.checked = false; }
    });
  });
  panel.querySelector('.tx-filter-apply').addEventListener('click', () => {
    const checked = Array.from(panel.querySelectorAll('.tx-filter-chk')).filter(c => c.checked).map(c => c.value);
    if(checked.length === 0 || checked.length === values.length){
      delete contPickColFilters[col];
    } else {
      contPickColFilters[col] = new Set(checked);
    }
    cptCloseFilterDropdown();
    renderContPickTable();
  });
  panel.querySelector('.tx-filter-reset').addEventListener('click', () => {
    delete contPickColFilters[col];
    cptCloseFilterDropdown();
    renderContPickTable();
  });
}

document.addEventListener('click', (e) => {
  const filterBtn = e.target.closest('.cpt-filter-btn');
  if(filterBtn){
    e.stopPropagation();
    cptToggleColumnFilterDropdown(filterBtn.dataset.col, filterBtn);
    return;
  }
  const sortBtn = e.target.closest('.cpt-sort-btn');
  if(sortBtn){
    const col = sortBtn.dataset.sort;
    if(contPickSort.col === col) contPickSort.dir *= -1;
    else { contPickSort.col = col; contPickSort.dir = 1; }
    renderContPickTable();
  }
});

document.addEventListener('click', (e) => {
  if(e.target.closest('#btn-fixed-back-to-pick')){
    const panel = document.getElementById('cont-picking-overview');
    if(panel) panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  const shortBadge = e.target.closest('[data-jump-combined]');
  if(shortBadge){
    const pickingNavBtn = document.querySelector('.sidebar-nav-btn[data-page="picking"]');
    if(pickingNavBtn && !pickingNavBtn.classList.contains('active')) pickingNavBtn.click();
    setTimeout(() => {
      const target = document.getElementById(shortBadge.dataset.jumpCombined);
      const flash = (el) => {
        const prevBg = el.style.background;
        el.style.background = 'rgba(214,57,75,0.18)';
        el.style.transition = 'background 0.3s';
        setTimeout(() => { el.style.background = prevBg; }, 1800);
      };
      if(target){
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        flash(target);
      } else if(combinedPlanCache){
        // Không thấy trong bảng chính -> mã này có thể thuộc nhóm SPP (đã tách riêng ra popup, xem
        // renderSppPlanPopup) -> tự mở popup đó thay vì im lặng bỏ qua không tìm thấy gì.
        const inSpp = combinedPlanCache.sppRows.some(r =>
          combinedRowDomId(r.item, r.anyPO ? '' : r.custpo) === shortBadge.dataset.jumpCombined);
        if(inSpp){
          renderSppPlanPopup();
          const overlay = document.getElementById('spp-plan-overlay');
          if(overlay) overlay.classList.add('show');
          setTimeout(() => {
            const sppTarget = document.getElementById(shortBadge.dataset.jumpCombined);
            if(sppTarget){ sppTarget.scrollIntoView({ behavior: 'smooth', block: 'center' }); flash(sppTarget); }
          }, 80);
        }
      }
    }, 60);
    return; // không cho nổi bọt lên xử lý click hàng container bên dưới
  }
  const ngRow = e.target.closest('.ov-ng-row[data-jump-search]');
  if(ngRow){
    // Bấm 1 dòng "Hàng NG" -> chuyển sang trang "Tìm mã hàng", chọn đúng tab kho, tự điền
    // mã + PO + locator + trạng thái NG vào ô tìm kiếm nhiều-mã, rồi mở cả 2 bảng
    // (Tổng hợp + Dữ liệu gốc theo dòng) và cuộn tới.
    const searchNavBtn = document.querySelector('.sidebar-nav-btn[data-page="search"]');
    if(searchNavBtn && !searchNavBtn.classList.contains('active')) searchNavBtn.click();
    setTimeout(() => {
      const khoTabBtn = document.querySelector(`#kho-tabs .kho-tab[data-kho="${CSS.escape(ngRow.dataset.khoLabel || '')}"]`);
      if(khoTabBtn && !khoTabBtn.classList.contains('active')) khoTabBtn.click();
      const ta = document.getElementById('kho-multi-search');
      if(ta){
        const parts = [ngRow.dataset.item, ngRow.dataset.po, ngRow.dataset.locator, 'NG'].filter(v => v && v.trim());
        ta.value = parts.join(' ');
        ta.dispatchEvent(new Event('input', { bubbles: true }));
      }
      const khoPanel = document.getElementById('kho-summary-panel');
      const rawPanel = document.getElementById('raw-detail-panel');
      if(khoPanel && typeof ccSetCollapsePanelOpen === 'function') ccSetCollapsePanelOpen(khoPanel, true);
      if(rawPanel && typeof ccSetCollapsePanelOpen === 'function') ccSetCollapsePanelOpen(rawPanel, true);
      if(khoPanel) khoPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 80);
    return;
  }
  const pickSlipBtn = e.target.closest('.cpt-pick-slip-btn');
  if(pickSlipBtn){
    openPickSlip(pickSlipBtn.dataset.pickType, pickSlipBtn.dataset.pickCno, pickSlipBtn.dataset.pickInstance);
    return;
  }
  const markBtn = e.target.closest('.cpt-mark-btn');
  if(markBtn){
    togglePickedManual(markBtn.dataset.markType, markBtn.dataset.markCno, markBtn.dataset.markLoaddate, markBtn.dataset.markPlantime);
    return;
  }
  const deleteBtn = e.target.closest('.cpt-delete-btn');
  if(deleteBtn){
    deleteContainerFromPlan(deleteBtn.dataset.deleteType, deleteBtn.dataset.deleteCno, deleteBtn.dataset.deleteLoaddate, deleteBtn.dataset.deletePlantime);
    return;
  }
  const restoreBtn = e.target.closest('.cpt-hidden-cont-restore');
  if(restoreBtn){
    restoreHiddenContainer(restoreBtn.dataset.restoreType, restoreBtn.dataset.restoreCno, restoreBtn.dataset.restoreLoaddate, restoreBtn.dataset.restorePlantime);
    return;
  }
  if(e.target.closest('.cpt-kho-manual-select')) return; // để dropdown chọn Kho hoạt động, không nhảy dòng
  if(e.target.closest('.cpt-comment-input')) return; // để bấm/gõ vào ô Ghi chú hoạt động, không nhảy dòng
  const row = e.target.closest('.cont-pick-row');
  if(!row) return;
  const domId = row.dataset.contJump;
  const target = document.getElementById('plan-cont-row-' + domId);
  if(!target) return;
  target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  // SỬA (lỗi thật đã gặp — thử cả outline offset dương lẫn position:relative + z-index đều vẫn bị
  // dòng kế bên vẽ đè lên che mất, vì outline có thể tràn RA NGOÀI khung dòng nên luôn có nguy cơ đụng
  // độ vẽ với dòng lân cận bất kể mẹo xếp lớp nào): bỏ hẳn outline trên <tr>, đổi sang tô MÀU NỀN TRÊN
  // TỪNG Ô (class .tn5-row-jump-flash, xem @keyframes tn5RowJumpFlash trong styles.css) — nền của Ô
  // LUÔN được trình duyệt vẽ ĐÈ LÊN TRÊN nền của Dòng theo đúng quy tắc vẽ nền bảng HTML tiêu chuẩn,
  // không phụ thuộc z-index/thứ tự DOM giữa các dòng như outline, nên chắc chắn không thể bị che nữa.
  target.classList.remove('tn5-row-jump-flash');
  void target.offsetWidth; // ép trình duyệt "chốt" lại trạng thái đã bỏ class, để lỡ bấm nhảy liên tục vẫn tự chạy lại animation từ đầu mỗi lần
  target.classList.add('tn5-row-jump-flash');
  setTimeout(() => { target.classList.remove('tn5-row-jump-flash'); }, 1600);
});

document.addEventListener('change', (e) => {
  const sel = e.target.closest('.cpt-kho-manual-select');
  if(!sel) return;
  setManualKho(sel.dataset.manualType, sel.dataset.manualCno, sel.dataset.manualLoaddate, sel.dataset.manualPlantime, sel.value || null);
});

// Ghi chú tự điền ở bảng Thống kê Container — lưu (localStorage + tự lưu Cloud) khi ĐIỀN XONG (sự
// kiện "change" chỉ nổ ra khi rời khỏi ô/nhấn Enter, không phải mỗi lần gõ phím), theo đúng yêu cầu.
document.addEventListener('change', (e) => {
  const input = e.target.closest('.cpt-comment-input');
  if(!input) return;
  saveContPickComment(input.dataset.instance, input.value);
});

(function setupFixedBackToPickBtn(){
  const btn = document.getElementById('btn-fixed-back-to-pick');
  const panel = document.getElementById('cont-picking-overview');
  if(!btn || !panel) return;
  if('IntersectionObserver' in window){
    const io = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        btn.style.display = (entry.isIntersecting || panel.style.display === 'none') ? 'none' : 'flex';
      });
    }, { threshold: 0.05 });
    io.observe(panel);
  }
})();

/* ============ Popover chi tiết mã hàng/locator khi hover 1 dòng trong bảng thống kê container ============ */
let contPickRowsCache = [];

function buildContPickTooltipHtml(items){
  if(!items || !items.length) return '<div class="cpt-empty">Không có mã hàng</div>';
  return items.map(it => {
    const locsHtml = it.locs.length
      ? `<div class="cpt-locs">${it.locs.map(l => `<div class="cpt-loc-row"><span>${escHtml(l.locator)}</span><b>${fmt(l.qty)}</b></div>`).join('')}</div>`
      : `<div class="cpt-empty">Không có tồn kho</div>`;
    // Gộp thêm tổng tồn theo TỪNG KHO (3B/3A/2B/DG1...) cho mã hàng này — bên cạnh chi tiết theo
    // từng Locator ở trên, để biết ngay kho nào đang giữ bao nhiêu mà không cần cộng tay từng dòng.
    const khoTotals = new Map();
    it.locs.forEach(l => khoTotals.set(l.kho, (khoTotals.get(l.kho) || 0) + l.qty));
    const khoOrder = [...new Set([...CPT_KHO_ORDER, ...khoTotals.keys()])];
    const khoRowsHtml = khoOrder
      .filter(kho => khoTotals.has(kho))
      .map(kho => `<div class="cpt-loc-row"><span>${escHtml((kho || '—').replace('Kho ', ''))}</span><b>${fmt(khoTotals.get(kho))}</b></div>`)
      .join('');
    const khoBlockHtml = khoRowsHtml
      ? `<div class="cpt-total" style="color:var(--muted); font-weight:600; margin-top:4px;">Theo kho:</div><div class="cpt-locs">${khoRowsHtml}</div>`
      : '';
    return `<div class="cpt-item">
      <div class="cpt-item-head"><b>${escHtml(it.item)}</b>${it.po ? ` <span class="cpt-po">(PO ${escHtml(it.po)})</span>` : ''} <span class="cpt-kh">— KH ${fmt(it.qty)} Pcs</span></div>
      ${locsHtml}
      ${khoBlockHtml}
      <div class="cpt-total">Tổng tồn hiện có: <b>${fmt(it.totalOnHand)}</b> Pcs</div>
    </div>`;
  }).join('');
}

function positionContPickTooltip(x, y){
  const el = document.getElementById('cont-pick-tooltip');
  if(!el) return;
  const pad = 16;
  let left = x + pad;
  let top = y + pad;
  const rect = el.getBoundingClientRect();
  if(left + rect.width > window.innerWidth - 8) left = x - rect.width - pad;
  if(left < 8) left = 8;
  if(top + rect.height > window.innerHeight - 8) top = window.innerHeight - rect.height - 8;
  if(top < 8) top = 8;
  el.style.left = left + 'px';
  el.style.top = top + 'px';
}

// Chuyển "dd/mm/yyyy" + "HH:MM" (có thể là chuỗi gộp nhiều giá trị cách nhau bởi ', ') thành
// mốc thời gian để sắp xếp — container chưa rõ ngày/giờ được xếp xuống cuối.
function ovParseDateTimeSortKey(dateStr, timeStr){
  const d = String(dateStr || '').split(',')[0].trim();
  const t = String(timeStr || '').split(',')[0].trim();
  const dm = d.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if(!dm) return Infinity;
  const tm = t.match(/^(\d{1,2}):(\d{2})/);
  const hh = tm ? Number(tm[1]) : 0, mi = tm ? Number(tm[2]) : 0;
  return new Date(Number(dm[3]), Number(dm[2]) - 1, Number(dm[1]), hh, mi).getTime();
}

// Trả về danh sách các container (theo Plan xuất cont đã tải) có đóng đúng mã hàng + PO này.
function buildItemContainerList(item, po){
  const itemKey = String(item||'').trim().toLowerCase();
  const poKey = String(po||'').trim().toLowerCase();
  const result = [];
  contPickAllRows.forEach(row => {
    (row.items || []).forEach(it => {
      if(String(it.item||'').trim().toLowerCase() !== itemKey) return;
      if(String(it.po||'').trim().toLowerCase() !== poKey) return;
      result.push({
        type: row.type, cNo: row.cNo, qty: it.qty, cbm: it.cbm,
        loadDate: row.loadDate, planTime: row.planTime,
        invoice: row.invoice, csr: row.csr,
        status: row.status
      });
    });
  });
  result.sort((a,b) => ovParseDateTimeSortKey(a.loadDate, a.planTime) - ovParseDateTimeSortKey(b.loadDate, b.planTime));
  return result;
}

const CPT_KHO_ORDER = ['Kho 2B', 'Kho 3A', 'Kho 3B', 'Kho DG1'];

function buildItemLocatorPopoverHtml(item, po){
  const conts = buildItemContainerList(item, po);
  const poNote = po ? ` <span class="cpt-po">(PO ${escHtml(po)})</span>` : '';
  if(!conts.length){
    return `<div class="cpt-item-head"><b>${escHtml(item)}</b>${poNote}</div><div class="cpt-empty">Không có container nào đóng mã hàng này (trong Plan xuất cont đã tải)</div>`;
  }
  const totalQty = conts.reduce((s, c) => s + c.qty, 0);
  // SỬA (lỗi thật đã gặp — popover báo "Đủ" trong khi bảng so sánh chính báo "Thiếu" cho ĐÚNG mã này):
  // trước đây cộng TẤT CẢ OQC (PASS+NG+khác) làm "Tổng tồn hiện có", trong khi bảng so sánh chính
  // (buildCombinedPlanCompareTable) VÀ mọi chỗ khác tính "Thiếu hàng" trong dashboard chỉ tính đúng
  // hàng PASS là tồn khả dụng (hàng NG không xuất được) — 2 cách tính khác nhau cho cùng 1 mã hàng
  // dẫn tới kết luận Đủ/Thiếu trái ngược nhau. Lọc lại đúng PASS để khớp quy ước chung.
  const locs = buildItemLocatorDetail(item, po, true).filter(l => l.oqc === 'PASS'); // loại vị trí "Prod" + chỉ tính PASS là tồn khả dụng để pick
  const totalOnHand = locs.reduce((s, l) => s + l.qty, 0);
  const khoTotals = new Map();
  locs.forEach(l => khoTotals.set(l.kho, (khoTotals.get(l.kho)||0) + l.qty));
  const khoOrder = [...new Set([...CPT_KHO_ORDER, ...khoTotals.keys()])];
  const khoRowsHtml = khoOrder
    .filter(kho => khoTotals.has(kho))
    .map(kho => `<div class="cpt-loc-row"><span>${escHtml(kho.replace('Kho ', ''))}</span><b>${fmt(khoTotals.get(kho))}</b></div>`)
    .join('');
  const diff = totalOnHand - totalQty;
  const isSpp = ccIsSppItem(item);
  const manualOk = isSpp && !!sppManualOk[sppOkKey(item, po)];
  const diffHtml = manualOk
    ? `<div class="cpt-total" style="color:var(--teal); font-weight:600;">Đủ ✓ (đã tick thủ công — SPP)</div>`
    : diff >= 0
      ? `<div class="cpt-total" style="color:var(--teal); font-weight:600;">Đủ (dư ${fmt(diff)} Pcs)</div>`
      : `<div class="cpt-total" style="color:var(--red); font-weight:600;">Thiếu ${fmt(-diff)} Pcs</div>`;
  const rowsHtml = conts.map(c => {
    const dateTimeParts = [c.loadDate, c.planTime].filter(v => v && v !== '—');
    const subLine = dateTimeParts.length ? `<div class="cpt-loc-sub">${escHtml(dateTimeParts.join(' · '))}</div>` : '';
    return `<div class="cpt-loc-row"><span>${escHtml(c.type)}-${escHtml(String(c.cNo))} <span style="color:${CONT_PICK_STATUS_COLOR[c.status]}; font-weight:600;">(${CONT_PICK_STATUS_LABEL[c.status]})</span></span><b>${fmt(c.qty)}</b></div>${subLine}`;
  }).join('');
  return `<div class="cpt-item-head"><b>${escHtml(item)}</b>${poNote}</div>
    <div class="cpt-locs">${rowsHtml}</div>
    <div class="cpt-total">Tổng ${fmt(conts.length)} container: <b>${fmt(totalQty)}</b> Pcs</div>
    <div class="cpt-total" style="color:var(--muted); font-weight:600; margin-top:6px;">Tổng tồn PASS hiện có: <b style="color:var(--text);">${fmt(totalOnHand)}</b> Pcs</div>
    <div class="cpt-locs">${khoRowsHtml || '<div class="cpt-empty">Không có tồn kho</div>'}</div>
    ${diffHtml}`;
}

let cptPinned = false;
let cptCtrlDown = false;
// Thiết bị cảm ứng (iPhone/iPad...) không có "hover" thật — nếu vẫn gắn listener
// mouseover/mouseout vào document, Safari trên iOS sẽ bắt MỌI nút bấm trên trang
// phải chạm 2 lần mới nhận (lần 1 coi là "hover", lần 2 mới tính là "click").
// Nên toàn bộ popover hover chỉ bật trên thiết bị có chuột thật.
const IS_TOUCH_DEVICE = (typeof window.matchMedia === 'function' && window.matchMedia('(hover: none), (pointer: coarse)').matches) || ('ontouchstart' in window);

if(!IS_TOUCH_DEVICE){
  document.addEventListener('mouseover', (e) => {
    if(cptPinned) return;
    const row = e.target.closest('.cont-pick-row');
    if(row){
      const idx = Number(row.dataset.rowIdx);
      const data = contPickRowsCache[idx];
      const bodyEl = document.getElementById('cont-pick-tooltip-body');
      const el = document.getElementById('cont-pick-tooltip');
      if(!data || !el || !bodyEl) return;
      bodyEl.innerHTML = buildContPickTooltipHtml(data.items);
      el.style.display = 'flex';
      positionContPickTooltip(e.clientX, e.clientY);
      return;
    }
    const link = e.target.closest('.item-link');
    if(link){
      const bodyEl = document.getElementById('cont-pick-tooltip-body');
      const el = document.getElementById('cont-pick-tooltip');
      if(!el || !bodyEl) return;
      bodyEl.innerHTML = buildItemLocatorPopoverHtml(link.dataset.item, link.dataset.po || '');
      el.style.display = 'flex';
      positionContPickTooltip(e.clientX, e.clientY);
      return;
    }
    const ovSeg = e.target.closest('.ov-dist-badge[data-kho], .ov-dist-bar span[data-kho]');
    if(ovSeg){
      const bodyEl = document.getElementById('cont-pick-tooltip-body');
      const el = document.getElementById('cont-pick-tooltip');
      if(!el || !bodyEl) return;
      bodyEl.innerHTML = buildOvBucketTooltipHtml(ovSeg.dataset.kho, Number(ovSeg.dataset.bucket));
      el.style.display = 'flex';
      positionContPickTooltip(e.clientX, e.clientY);
    }
  });
  document.addEventListener('mousemove', (e) => {
    if(cptPinned) return;
    const el = document.getElementById('cont-pick-tooltip');
    if(el && el.style.display === 'flex') positionContPickTooltip(e.clientX, e.clientY);
  });
  document.addEventListener('mouseout', (e) => {
    if(cptPinned) return;
    const row = e.target.closest('.cont-pick-row');
    if(row){
      if(row.contains(e.relatedTarget)) return;
      const el = document.getElementById('cont-pick-tooltip');
      if(el) el.style.display = 'none';
      return;
    }
    const link = e.target.closest('.item-link');
    if(link){
      if(link.contains(e.relatedTarget)) return;
      const el = document.getElementById('cont-pick-tooltip');
      if(el) el.style.display = 'none';
      return;
    }
    const ovSeg = e.target.closest('.ov-dist-badge[data-kho], .ov-dist-bar span[data-kho]');
    if(ovSeg){
      if(ovSeg.contains(e.relatedTarget)) return;
      const el = document.getElementById('cont-pick-tooltip');
      if(el) el.style.display = 'none';
    }
  });

  /* Giữ phím Shift để "ghim" khung popover đang hiện — cho phép đưa chuột vào bên trong để cuộn */
  document.addEventListener('keydown', (e) => {
    if(e.key !== 'Shift' || cptCtrlDown) return;
    cptCtrlDown = true;
    const el = document.getElementById('cont-pick-tooltip');
    if(el && el.style.display === 'flex' && !cptPinned){
      cptPinned = true;
      el.classList.add('cpt-pinned');
    }
  });
  document.addEventListener('keyup', (e) => {
    if(e.key !== 'Shift') return;
    cptCtrlDown = false;
    if(cptPinned){
      cptPinned = false;
      const el = document.getElementById('cont-pick-tooltip');
      if(el){
        el.classList.remove('cpt-pinned');
        if(!el.matches(':hover')) el.style.display = 'none';
      }
    }
  });
  (function setupPinnedTooltipLeave(){
    const el = document.getElementById('cont-pick-tooltip');
    if(!el) return;
    el.addEventListener('mouseleave', () => {
      if(!cptCtrlDown){ cptPinned = false; el.classList.remove('cpt-pinned'); el.style.display = 'none'; }
    });
  })();
} else {
  // Trên điện thoại/máy tính bảng: ẩn hẳn gợi ý "giữ phím Ctrl" (không áp dụng được),
  // xem chi tiết mã hàng vẫn dùng được qua việc bấm mở rộng dòng / bấm vào container như cũ.
  const hintEl = document.querySelector('.cpt-hint');
  if(hintEl) hintEl.style.display = 'none';
}


// Container đã bị "xoá" (ẩn) khỏi Plan — coi như xoá THẬT SỰ: không tính vào bất kỳ số liệu tổng
// hợp hay bảng nào nữa (SL kế hoạch, số mã hàng, so sánh tồn kho...), dù dòng đó vẫn còn trong file
// Excel gốc (VD: cont ca trước đã load xong hoặc delay chưa có lịch, quên xoá khỏi Plan).
function isContainerHidden(type, cNo, loadDate, planTime){
  return !!hiddenPlanContainers[contInstanceKey(type, cNo || '', loadDate, planTime)];
}

// Dựng nội dung (các <td>) của 1 dòng CÓ THỂ SỬA trong bảng chi tiết Plan — dùng CHUNG cho cả lúc vẽ
// lại toàn bộ bảng (renderPlanPanel, khi đang ở chế độ Sửa) lẫn lúc bấm "+ Thêm dòng" (chỉ chèn thêm
// đúng 1 <tr> mới, không vẽ lại cả bảng để không mất các ô đang gõ dở).
function buildPlanEditRowCellsHtml(r, locCols){
  r = r || {};
  const loadDateStr = r.loadDate ? fmtDate(r.loadDate) : '';
  const locCells = locCols.map(name => {
    const v = r.locations && Object.prototype.hasOwnProperty.call(r.locations, name) ? r.locations[name] : '';
    return `<td><input type="number" class="plan-edit-input plan-edit-loc" data-loc-name="${escAttr(name)}" value="${v === null || v === undefined ? '' : v}"></td>`;
  }).join('');
  return `
    <td><input type="text" class="plan-edit-input plan-edit-cont" value="${escAttr(r.containerNo || '')}" placeholder="Cont"></td>
    <td><input type="text" class="plan-edit-input plan-edit-loaddate" value="${escAttr(loadDateStr)}" placeholder="dd/mm/yyyy"></td>
    <td><input type="text" class="plan-edit-input plan-edit-plantime" value="${escAttr(r.planTime || '')}" placeholder="hh:mm"></td>
    <td><input type="text" class="plan-edit-input plan-edit-item" value="${escAttr(r.item || '')}" placeholder="Item No."></td>
    <td><input type="text" class="plan-edit-input plan-edit-custpo" value="${escAttr(r.custPo || '')}"></td>
    <td><input type="number" class="plan-edit-input plan-edit-qty" value="${r.qty === null || r.qty === undefined ? '' : r.qty}"></td>
    <td><input type="number" class="plan-edit-input plan-edit-ctn" value="${r.ctn === null || r.ctn === undefined ? '' : r.ctn}"></td>
    <td><input type="number" step="0.01" class="plan-edit-input plan-edit-cbm" value="${r.cbm === null || r.cbm === undefined ? '' : r.cbm}"></td>${locCells}
    <td><input type="text" class="plan-edit-input plan-edit-type" value="${escAttr(r.type || '')}"></td>
    <td><input type="text" class="plan-edit-input plan-edit-invoice" value="${escAttr(r.invoice || '')}"></td>
    <td><input type="text" class="plan-edit-input plan-edit-csr" value="${escAttr(r.csr || '')}"></td>
    <td style="text-align:center"><button class="btn-row-del" data-row-del type="button" title="Xoá dòng này">🗑</button></td>`;
}

// Đọc lại TOÀN BỘ các dòng đang sửa (kể cả dòng mới thêm) trực tiếp từ DOM của đúng thẻ Plan này —
// KHÔNG dựa vào planData[type].detailRows cũ nữa (dữ liệu thật lúc này nằm ở các ô input trên màn hình).
function collectPlanEditRows(cardEl){
  const rows = [];
  cardEl.querySelectorAll('tbody tr.plan-edit-row').forEach(tr => {
    const val = sel => { const el = tr.querySelector(sel); return el ? el.value.trim() : ''; };
    const itemVal = val('.plan-edit-item');
    if(!itemVal) return; // dòng chưa nhập Item No. — bỏ qua, coi như dòng trống
    const loadDateVal = val('.plan-edit-loaddate');
    const locations = {};
    tr.querySelectorAll('.plan-edit-loc').forEach(inp => {
      const v = inp.value.trim();
      if(v !== '') locations[inp.dataset.locName] = parseNumber(v);
    });
    const ctnVal = val('.plan-edit-ctn');
    const cbmVal = val('.plan-edit-cbm');
    rows.push({
      loadDate: loadDateVal ? parseDateCell(loadDateVal) : null,
      planTime: val('.plan-edit-plantime'),
      item: normalizeItemCode(itemVal),
      custPo: val('.plan-edit-custpo'),
      qty: parseNumber(val('.plan-edit-qty')),
      ctn: ctnVal === '' ? null : parseNumber(ctnVal),
      cbm: cbmVal === '' ? null : parseNumber(cbmVal),
      type: val('.plan-edit-type'),
      containerNo: val('.plan-edit-cont'),
      invoice: val('.plan-edit-invoice'),
      csr: val('.plan-edit-csr'),
      locations,
    });
  });
  return rows;
}

// Tính lại các số liệu tổng hợp (SL tổng, số mã hàng, số container, cột vị trí...) của planData[type]
// sau khi detailRows bị SỬA TAY — y hệt phần tổng hợp trong aggregatePlanRows(), nhưng chạy trên
// detailRows đã có sẵn thay vì đọc lại từ file Excel gốc.
function recomputePlanAgg(type){
  const rows = planData[type].detailRows || [];
  const byItem = {};
  const containers = new Set();
  const locSet = new Set();
  let totalQty = 0;
  let nearestDate = null;
  rows.forEach(r => {
    const key = (r.item || '').toLowerCase();
    byItem[key] = (byItem[key] || 0) + (r.qty || 0);
    totalQty += (r.qty || 0);
    if(r.containerNo) containers.add(r.containerNo);
    if(r.loadDate && (!nearestDate || r.loadDate < nearestDate)) nearestDate = r.loadDate;
    if(r.locations) Object.keys(r.locations).forEach(k => locSet.add(k));
  });
  const pad = n => String(n).padStart(2,'0');
  planData[type].byItem = byItem;
  planData[type].rowCount = rows.length;
  planData[type].totalQty = totalQty;
  planData[type].itemCount = Object.keys(byItem).length;
  planData[type].containerCount = containers.size || null;
  planData[type].nearestDateStr = nearestDate ? `${pad(nearestDate.getUTCDate())}/${pad(nearestDate.getUTCMonth()+1)}/${nearestDate.getUTCFullYear()}` : null;
  planData[type].locationColumns = Array.from(locSet);
}

function renderPlanPanel(){
  const loadedTypes = PLAN_TYPES.filter(t => planData[t]);
  // Tính lại trạng thái Pick (contPickAllRows) TRƯỚC khi dựng các bảng so sánh SL Plan vs Tồn kho —
  // để các bảng so sánh biết chính xác container nào đã "Pick xong" ngay trong lần vẽ này, không bị
  // trễ 1 nhịp (nếu tính sau thì bảng so sánh vẫn dùng dữ liệu Pick cũ của lần vẽ trước).
  renderContainerPickingOverview();
  renderCombinedPlanPanel();

  if(!planCardsEl){
    // Nếu không có element thì thoát
    return;
  }

  if(!loadedTypes.length){
    planCardsEl.innerHTML = `<div class="kho-empty" style="display:block;">Chưa có Plan nào được tải lên.<br>Dùng thanh "Plan xuất cont" ở đầu trang để tải lên Plan Row / FC / HCP.</div>`;
    return;
  }

  const pickingIdx = buildPickingIndex(currentData);

  const CONT_COLOR_PALETTE = GROUP_COLOR_PALETTE;

  planCardsEl.innerHTML = loadedTypes.map(type => {
    const isEditing = planEditingTypes.has(type);
    const rows = (planData[type].detailRows || []).filter(r => !isContainerHidden(type, r.containerNo, r.loadDate ? fmtDate(r.loadDate) : '', r.planTime || ''));
    const totalQtyDisplay = rows.reduce((s,r) => s + (r.qty || 0), 0);
    const itemCountDisplay = new Set(rows.map(r => (r.item || '').toLowerCase())).size;
    const containerSetDisplay = new Set(rows.map(r => r.containerNo).filter(c => c && c !== '—'));
    const locCols = planData[type].locationColumns || [];
    const detailColCount = 12 + locCols.length;
    if(isEditing){
      // Chế độ SỬA: mỗi dòng là 1 ô nhập liệu — không tô màu container/Picking Status nữa (những cái
      // đó phụ thuộc dữ liệu ĐÃ LƯU, trong lúc sửa dở dữ liệu thật nằm ở các ô input, chưa ghi vào
      // planData[type] cho tới khi bấm "Lưu", xem collectPlanEditRows()/nút data-plan-edit-save).
      const editRowsHtml = rows.map(r => `<tr class="plan-edit-row">${buildPlanEditRowCellsHtml(r, locCols)}</tr>`).join('');
      return `
      <div class="plan-card plan-card-editing" style="border:2px solid ${PLAN_COLORS[type]}; background:linear-gradient(90deg, ${PLAN_COLORS[type]}14, transparent 120px);">
        <div class="plan-card-head">
          <span class="plan-card-badge" style="background:${PLAN_COLORS[type]};">${type}</span>
          <span class="plan-card-title" style="color:${PLAN_COLORS[type]}">Plan ${type} — đang sửa</span>
          <span class="plan-card-file" title="${planData[type].fileName}">${planData[type].fileName}</span>
          <div class="plan-edit-actions">
            <button class="btn-plan-save" data-plan-edit-save="${type}" type="button">💾 Lưu</button>
            <button class="btn-plan-cancel" data-plan-edit-cancel="${type}" type="button">✕ Huỷ</button>
          </div>
        </div>
        <div class="plan-card-chart-label">Sửa trực tiếp bảng chi tiết (${rows.length} dòng) &nbsp; <span class="compare-summary" style="font-family:var(--mono); font-size:10px; color:var(--muted-2);">Bỏ trống Item No. để xoá dòng lúc Lưu · Bấm 🗑 để xoá ngay 1 dòng</span></div>
        <div class="plan-table-wrap">
          <table class="plan-detail-table plan-detail-table-edit" data-colspan="${detailColCount}">
            <thead>
              <tr>
                <th>Cont</th><th>Loading Date</th><th>Plan Time</th><th>TTI Model</th><th>Customer PO</th>
                <th style="text-align:right">QTY</th><th style="text-align:right">CTN</th><th style="text-align:right">CBM</th>${locCols.map(name=>`<th style="text-align:right" class="loc-head">${name}</th>`).join('')}
                <th>Type</th><th>Invoice</th><th>CSR</th>
                <th>Xoá</th>
              </tr>
            </thead>
            <tbody>${editRowsHtml}<tr class="plan-add-row-trigger"><td colspan="${detailColCount}" style="text-align:center; padding:10px;"><button class="btn-plan-add-row" data-plan-add-row="${type}" type="button">+ Thêm dòng</button></td></tr></tbody>
          </table>
        </div>
        <div class="plan-card-chart-label">Bảng so sánh SL tồn vs Plan sẽ cập nhật lại sau khi bấm "💾 Lưu".</div>
      </div>`;
    }
    const contColorMap = new Map();
    let lastContainer = null;
    const rowsHtml = rows.map(r => {
      const cNo = r.containerNo || '—';
      const isNewGroup = cNo !== lastContainer;
      lastContainer = cNo;
      if(cNo !== '—' && !contColorMap.has(cNo)) contColorMap.set(cNo, CONT_COLOR_PALETTE[contColorMap.size % CONT_COLOR_PALETTE.length]);
      const contColor = contColorMap.get(cNo) || '#8892A0';
      // SỬA (theo yêu cầu — "màu chưa phân ra rõ từng cont"): 0.07 quá nhạt, gần như không nhận ra khi
      // lướt mắt xuống bảng nhiều dòng. Tăng lên 0.16 cho rõ hẳn, đồng thời truyền màu container qua
      // biến CSS --cont-line để viền trên của dòng ĐẦU TIÊN mỗi container (xem .cont-group-first ở
      // styles.css) tô ĐÚNG màu container đó thay vì 1 màu xám chung chung như trước — biến CSS đặt ở
      // <tr> vẫn tự "chảy" xuống các <td> con dù bảng dùng border-collapse (khác border thường không
      // ăn khi đặt trực tiếp trên <tr> có border-collapse).
      const rowBg = hexToRgba(contColor, 0.16);
      const groupCls = isNewGroup ? 'cont-group-first' : '';
      const locCells = locCols.map(name => {
        const v = r.locations && Object.prototype.hasOwnProperty.call(r.locations, name) ? r.locations[name] : null;
        return `<td class="num loc-cell">${v !== null ? fmt(v) : ''}</td>`;
      }).join('');

      // Tính Picking Status: chỉ dùng CSR, không dùng locator PICK
      const itemKey = r.item.toLowerCase();
      const csrKey = (r.csr || '').trim().toLowerCase();
      let passQty = 0;
      if(csrKey){
        const lookupKey = itemKey + '|' + csrKey;
        passQty = pickingIdx[lookupKey] || 0;
      }
      // Không có fallback sang PICK
      const planQty = r.qty || 0;
      let pct = 0;
      let tooltip = '';
      if(planQty > 0){
        pct = Math.min(100, (passQty / planQty) * 100);
        tooltip = `${fmt(passQty)} PASS / ${fmt(planQty)} kế hoạch`;
        if(csrKey) tooltip += ` (CSR: ${r.csr})`;
        // Không có thêm "tại vị trí PICK"
      } else {
        tooltip = 'Không có số lượng kế hoạch';
      }
      const barColor = pct >= 100 ? 'var(--teal)' : (pct >= 70 ? 'var(--amber-bright)' : 'var(--red)');
      const barHtml = `<div class="picking-bar-wrap" title="${tooltip}">
        <div class="picking-bar-track"><div class="picking-bar-fill" style="width:${pct}%; background:${barColor};"></div></div>
        <span class="picking-bar-label">${pct.toFixed(0)}%</span>
      </div>`;

      const rowId = isNewGroup ? ` id="plan-cont-row-${contDomId(type, cNo)}"` : '';
      return `
      <tr class="${groupCls}"${rowId} style="background:${rowBg}; --cont-line:${contColor};">
        <td class="cont-no-cell" style="border-left-color:${contColor};"><span class="cont-badge" style="background:${contColor}">${cNo}</span></td>
        <td>${r.loadDate ? fmtDate(r.loadDate) : '—'}</td>
        <td>${r.planTime || '—'}</td>
        <td><span class="item-link" data-item="${r.item}" data-po="${r.custPo || ''}">${r.item} <span class="item-link-arrow">▸</span></span></td>
        <td>${r.custPo || '—'}</td>
        <td class="num">${fmt(r.qty)}</td>
        <td class="num">${fmtDec(r.ctn, 0)}</td>
        <td class="num">${fmtDec(r.cbm, 2)}</td>${locCells}
        <td>${r.type || '—'}</td>
        <td>${r.invoice || '—'}</td>
        <td>${r.csr || '—'}</td>
        <td>${barHtml}</td>
      </tr>`;
    }).join('');
    const compare = buildCompareTable(type);
    return `
    <div class="plan-card" style="border:2px solid ${PLAN_COLORS[type]}; background:linear-gradient(90deg, ${PLAN_COLORS[type]}14, transparent 120px);">
      <div class="plan-card-head">
        <span class="plan-card-badge" style="background:${PLAN_COLORS[type]};">${type}</span>
        <span class="plan-card-title" style="color:${PLAN_COLORS[type]}">Plan ${type}</span>
        <span class="plan-card-file" title="${planData[type].fileName}">${planData[type].fileName}</span>
        <button class="btn-plan-edit" data-plan-edit="${type}" type="button" title="Sửa trực tiếp bảng chi tiết Plan này">✏️ Sửa</button>
      </div>
      <div class="plan-card-kpis">
        <div><b>${fmt(totalQtyDisplay)}</b><span>Tổng SL kế hoạch</span></div>
        <div><b>${itemCountDisplay}</b><span>Mã hàng</span></div>
        <div><b>${containerSetDisplay.size || '—'}</b><span>Container</span></div>
        ${planData[type].nearestDateStr ? `<div><b>${planData[type].nearestDateStr}</b><span>Ngày load gần nhất</span></div>` : ''}
      </div>
      <div class="plan-card-chart-label">Chi tiết kế hoạch xuất (${rows.length} dòng) &nbsp; <span class="compare-summary" style="font-family:var(--mono); font-size:10px; color:var(--muted-2);">Mỗi màu = 1 container</span></div>
      <div class="plan-table-wrap">
        <table class="plan-detail-table" data-colspan="${detailColCount}">
          <thead>
            <tr>
              <th>Cont</th><th>Loading Date</th><th>Plan Time</th><th>TTI Model</th><th>Customer PO</th>
              <th style="text-align:right">QTY</th><th style="text-align:right">CTN</th><th style="text-align:right">CBM</th>${locCols.map(name=>`<th style="text-align:right" class="loc-head">${name}</th>`).join('')}
              <th>Type</th><th>Invoice</th><th>CSR</th>
              <th>Picking Status</th>
            </tr>
          </thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      </div>
      <div class="plan-card-chart-label compare-label-row">
        <span>So sánh SL tồn theo kho vs SL xuất còn cần theo Plan (theo Item + Cust PO, đã trừ container Pick xong) &nbsp; <span class="compare-summary"><span class="compare-badge ok">Đủ ${compare.okCount}</span> <span class="compare-badge short">Thiếu ${compare.shortCount}</span>${compare.poMismatchCount ? ` <span class="compare-badge warn">⚠ ${compare.poMismatchCount} PO không khớp tồn kho</span>` : ''}</span></span>
        <button class="btn-export-excel" data-export-plan="${type}" type="button">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="m7 11 5 5 5-5"/><path d="M5 21h14"/></svg>
          Xuất Excel
        </button>
      </div>
      <div class="plan-table-wrap">${compare.html}</div>
    </div>`;
  }).join('');

  const planOverviewRow = document.getElementById('plan-overview-row');
  if(planOverviewRow) planOverviewRow.style.display = loadedTypes.length ? '' : 'none';
}

// Các nút thao tác Sửa/Lưu/Huỷ/Thêm dòng/Xoá dòng trong bảng chi tiết Plan — TẤT CẢ đều nằm trong
// nội dung do renderPlanPanel() vẽ lại bằng innerHTML nên phải bắt sự kiện kiểu "delegated" (gắn trên
// document, lọc theo nút con được bấm) thay vì gắn trực tiếp lên từng nút lúc khởi tạo trang.
document.addEventListener('click', (e) => {
  const editBtn = e.target.closest('[data-plan-edit]');
  if(editBtn){
    planEditingTypes.add(editBtn.dataset.planEdit);
    renderPlanPanel();
    return;
  }
  const cancelBtn = e.target.closest('[data-plan-edit-cancel]');
  if(cancelBtn){
    planEditingTypes.delete(cancelBtn.dataset.planEditCancel);
    renderPlanPanel(); // KHÔNG đụng tới planData — huỷ chỉ đơn giản là vẽ lại đúng dữ liệu đã lưu trước đó
    return;
  }
  const saveBtn = e.target.closest('[data-plan-edit-save]');
  if(saveBtn){
    const type = saveBtn.dataset.planEditSave;
    const card = saveBtn.closest('.plan-card');
    const newRows = collectPlanEditRows(card);
    if(!newRows.length){
      alert('Chưa có dòng dữ liệu hợp lệ nào (thiếu Item No.) — chưa thể lưu. Nhập ít nhất 1 dòng có Item No. hoặc bấm "✕ Huỷ" để bỏ qua.');
      return;
    }
    planData[type].detailRows = newRows;
    recomputePlanAgg(type);
    planEditingTypes.delete(type);
    const statusEl = document.querySelector(`.plan-status[data-plan-status="${type}"]`);
    if(statusEl){ statusEl.className = 'plan-status ok'; statusEl.textContent = `✓ ${planData[type].fileName} · ${planData[type].itemCount} mã · ${fmt(planData[type].totalQty)} Pcs (đã sửa tay)`; }
    renderPlanPanel();
    renderKhoSearchPage();
    touchUpdatedAt();
    saveStateToStorage();
    schedulePlanAutoSaveToCloud();
    return;
  }
  const addRowBtn = e.target.closest('[data-plan-add-row]');
  if(addRowBtn){
    const type = addRowBtn.dataset.planAddRow;
    const triggerRow = addRowBtn.closest('tr');
    const tbody = triggerRow.parentElement;
    const locCols = (planData[type] && planData[type].locationColumns) || [];
    const tr = document.createElement('tr');
    tr.className = 'plan-edit-row';
    tr.innerHTML = buildPlanEditRowCellsHtml({}, locCols);
    tbody.insertBefore(tr, triggerRow);
    const firstInput = tr.querySelector('.plan-edit-cont');
    if(firstInput) firstInput.focus();
    return;
  }
  const delRowBtn = e.target.closest('[data-row-del]');
  if(delRowBtn){
    delRowBtn.closest('tr').remove();
    return;
  }
});

/* ============ TỔNG HỢP 3 PLAN (Row + FC + HCP) vs TỒN KHO ============ */
let combinedPlanCache = null;

function buildCombinedPlanCompareTable(){
  const loadedTypes = PLAN_TYPES.filter(t => planData[t]);
  const khoOrder = (currentData && currentData.kho_order) || [];
  const poIdx = buildItemCustPoIndex(currentData);
  const itemIdx = buildItemIndex(currentData);

  // Container nào đã "Pick xong" (tự động 100% hoặc đã đánh dấu thủ công) thì coi như đã lấy đủ
  // hàng cho các dòng Plan của container đó rồi — không tính SL của các dòng này vào "còn cần" nữa,
  // để không báo Thiếu nhầm cho hàng đã xuất đi thực tế đang giảm dần trong kho.
  const doneContSet = new Set(
    (contPickAllRows || [])
      .filter(r => r.status === 'done' || r.status === 'manualDone')
      .map(r => r.instanceKey)
  );

  const planPairs = {};
  loadedTypes.forEach(type => {
    for(const r of (planData[type].detailRows || [])){
      const rLoadDateStr = r.loadDate ? fmtDate(r.loadDate) : '';
      const rPlanTimeStr = r.planTime || '';
      if(isContainerHidden(type, r.containerNo, rLoadDateStr, rPlanTimeStr)) continue; // container đã xoá khỏi Plan — bỏ qua hẳn
      const custpo = (r.custPo && r.custPo.trim()) ? r.custPo.trim() : '(Khong co)';
      const key = r.item.toLowerCase() + '\u241F' + custpo.toLowerCase();
      if(!planPairs[key]) planPairs[key] = { item: r.item, custpo, qtyByType: {}, totalPlanQty: 0 };
      const isDone = r.containerNo && doneContSet.has(contInstanceKey(type, r.containerNo, rLoadDateStr, rPlanTimeStr));
      if(isDone) continue; // container này đã pick xong — không tính vào SL còn cần nữa
      planPairs[key].qtyByType[type] = (planPairs[key].qtyByType[type] || 0) + r.qty;
      planPairs[key].totalPlanQty += r.qty;
    }
  });

  const rows = Object.values(planPairs).map(p => {
    const anyPO = p.custpo === '(Khong co)';
    let inv;
    if(anyPO){
      inv = itemIdx[p.item.toLowerCase()] || { byKho:{}, pass:0, ng:0, other:0 };
    } else {
      const key = p.item.toLowerCase() + '\u241F' + p.custpo.toLowerCase();
      inv = poIdx[key] || { byKho:{}, pass:0, ng:0, other:0 };
    }
    const khoQtys = khoOrder.map(k => inv.byKho[k] || 0);
    const totalOnHand = inv.pass || 0;
    const itemAnyPO = khoOrder.reduce((s,k) => s + ((itemIdx[p.item.toLowerCase()]||{}).byKho?.[k] || 0), 0);
    const poMismatch = !anyPO && totalOnHand === 0 && itemAnyPO > 0;
    // Nh\u00F3m SPP (Item No. kh\u00F4ng b\u1EAFt \u0111\u1EA7u b\u1EB1ng s\u1ED1 0) kh\u00F4ng c\u00F3 GI \u0111\u1EC3 t\u1EF1 nh\u1EADn bi\u1EBFt \u0111\u00E3 l\u1EA5y \u0111\u1EE7 h\u00E0ng nh\u01B0 m\u00E3
    // th\u01B0\u1EDDng \u2014 cho ph\u00E9p tick tay "\u0110\u1EE7 h\u00E0ng" (coi nh\u01B0 \u0111\u00E3 pick 100%) thay th\u1EBF, xem sppManualOk/toggleSppOk.
    const isSpp = ccIsSppItem(p.item);
    const manualOk = isSpp && !!sppManualOk[sppOkKey(p.item, p.custpo)];
    return {
      item: p.item, custpo: p.custpo, anyPO,
      qtyByType: p.qtyByType, totalPlanQty: p.totalPlanQty,
      khoQtys, totalOnHand, pass: inv.pass, ng: inv.ng,
      diff: totalOnHand - p.totalPlanQty, poMismatch, itemAnyPO,
      isSpp, manualOk
    };
  }).sort((a,b) => a.diff - b.diff);

  // "Thi\u1EBFu" = c\u00F2n thi\u1EBFu th\u1EADt (diff < 0) V\u00C0 ch\u01B0a \u0111\u01B0\u1EE3c tick tay "\u0110\u1EE7 h\u00E0ng" \u2014 d\u00F2ng SPP \u0111\u00E3 tick coi nh\u01B0
  // \u0111\u1EE7 (pick 100%) d\u00F9 s\u1ED1 Ch\u00EAnh l\u1EC7ch hi\u1EC3n th\u1ECB v\u1EABn gi\u1EEF nguy\u00EAn s\u1ED1 TH\u1EACT (kh\u00F4ng b\u1ECBa s\u1ED1 li\u1EC7u), ch\u1EC9 \u0111\u1ED5i
  // c\u00E1ch T\u00CDNH \u0110\u1EBEM/HI\u1EC2N TH\u1ECA tr\u1EA1ng th\u00E1i.
  const isShortRow = r => r.diff < 0 && !r.manualOk;
  const shortCount = rows.filter(isShortRow).length;
  const okCount = rows.length - shortCount;
  const poMismatchCount = rows.filter(r => r.poMismatch).length;
  // T\u00E1ch ri\u00EAng nh\u00F3m SPP ra kh\u1ECFi b\u1EA3ng ch\u00EDnh \u2014 hi\u1EC3n th\u1ECB g\u1ED9p trong popup ri\u00EAng (xem renderSppPlanPopup),
  // tr\u00E1nh l\u00E0m nhi\u1EC5u b\u1EA3ng so s\u00E1nh ch\u00EDnh v\u1ED1n ch\u1EC9 \u0111\u00E1ng tin cho nh\u00F3m h\u00E0ng c\u00F3 GI theo d\u00F5i \u0111\u01B0\u1EE3c t\u1EF1 \u0111\u1ED9ng.
  const mainRows = rows.filter(r => !r.isSpp);
  const sppRows = rows.filter(r => r.isSpp);

  return { rows, mainRows, sppRows, okCount, shortCount, poMismatchCount, loadedTypes, khoOrder };
}

// Dựng HTML 1 dòng so sánh — DÙNG CHUNG cho cả bảng chính (mainRows, không có cột tick) và popup
// nhóm SPP (sppRows, showTick=true để tick tay "Đủ hàng") — cùng 1 cách hiển thị, không viết 2 nơi
// dễ lệch nhau.
function combinedCompareRowHtml(r, loadedTypes, showTick){
  const typeCells = loadedTypes.map(t => `<td class="num">${r.qtyByType[t] ? fmt(r.qtyByType[t]) : '—'}</td>`).join('');
  const khoCells = (r.khoQtys || []).map(q => `<td class="num">${fmt(q)}</td>`).join('');
  const short = r.diff < 0 && !r.manualOk;
  const poCell = r.anyPO
    ? `<span class="po-any">Bất kỳ PO</span>`
    : (r.poMismatch
      ? `${escHtml(r.custpo)} <span class="po-warn" title="Không tìm thấy PO này trong tồn kho, nhưng mã hàng còn ${fmt(r.itemAnyPO)} Pcs ở PO khác">⚠</span>`
      : escHtml(r.custpo));
  const statusBadge = r.manualOk
    ? `<span class="compare-badge ok" title="Đã tick tay Đủ hàng (SPP) — coi như đã pick 100%">Đủ ✓</span>`
    : `<span class="compare-badge ${short?'short':'ok'}">${short?'Thiếu':'Đủ'}</span>`;
  const tickCell = showTick ? `
      <td style="text-align:center;">
        <label style="display:inline-flex; align-items:center; gap:6px; cursor:pointer; font-weight:600; ${r.manualOk?'color:var(--teal);':'color:var(--muted-2);'}">
          <input type="checkbox" data-spp-ok-item="${escAttr(r.item)}" data-spp-ok-po="${escAttr(r.custpo)}" ${r.manualOk?'checked':''}>
          Đủ hàng
        </label>
      </td>` : '';
  return `<tr class="compare-row" id="${combinedRowDomId(r.item, r.anyPO ? '' : r.custpo)}">
      <td><span class="item-link" data-item="${r.item}" data-po="${r.anyPO ? '' : r.custpo}">${escHtml(r.item)} <span class="item-link-arrow">▸</span></span></td>
      <td>${poCell}</td>
      ${typeCells}
      <td class="num" style="font-weight:700;">${fmt(r.totalPlanQty)}</td>
      ${khoCells}
      <td class="num" style="color:var(--text); font-weight:700;">${fmt(r.totalOnHand)}</td>
      <td class="num oqc-pass">${fmt(r.pass)}</td>
      <td class="num oqc-ng">${fmt(r.ng)}</td>
      <td class="num ${short?'diff-short':'diff-ok'}">${r.diff>=0?'+':''}${fmt(r.diff)}</td>
      <td>${statusBadge}</td>
      ${tickCell}
    </tr>`;
}

// Popup liệt kê riêng nhóm SPP (mở từ ô "Nhóm SPP" trong KPI của Tổng hợp 3 Plan) — cùng cột như
// bảng chính, kèm thêm cột tick "Đủ hàng" ở cuối.
function renderSppPlanPopup(){
  const el = document.getElementById('spp-plan-content');
  if(!el) return;
  const combined = combinedPlanCache;
  if(!combined || !combined.sppRows.length){
    el.innerHTML = `<div style="text-align:center; color:var(--muted-2); font-style:italic; padding:24px 0;">Không có mã SPP nào trong Tổng hợp 3 Plan hiện tại.</div>`;
    return;
  }
  const { sppRows, loadedTypes, khoOrder } = combined;
  const typeHead = loadedTypes.map(t => `<th style="text-align:right; color:${PLAN_COLORS[t]}">Plan ${t}</th>`).join('');
  const khoHead = (khoOrder || []).map(k => `<th style="text-align:right">${k.replace('Kho ','')}</th>`).join('');
  const bodyRows = sppRows.map(r => combinedCompareRowHtml(r, loadedTypes, true)).join('');
  el.innerHTML = `
    <table class="plan-detail-table compare-table">
      <thead><tr>
        <th>Item No.</th><th>Cust PO</th>${typeHead}
        <th style="text-align:right">Tổng Plan</th>
        ${khoHead}
        <th style="text-align:right">Tổng tồn (PASS)</th>
        <th style="text-align:right">PASS</th>
        <th style="text-align:right">NG</th>
        <th style="text-align:right">Chênh lệch</th>
        <th>Trạng thái</th>
        <th>Tick thủ công</th>
      </tr></thead>
      <tbody>${bodyRows}</tbody>
    </table>`;
}

document.addEventListener('click', (e) => {
  if(e.target.closest('#spp-plan-kpi-tile')){
    renderSppPlanPopup();
    const overlay = document.getElementById('spp-plan-overlay');
    if(overlay) overlay.classList.add('show');
    return;
  }
  if(e.target.id === 'spp-plan-overlay' || e.target.closest('#spp-plan-close')){
    const overlay = document.getElementById('spp-plan-overlay');
    if(overlay) overlay.classList.remove('show');
  }
});

// Tick "Đủ hàng" cho 1 dòng SPP = coi như đã lấy đủ/pick 100% (vì nhóm này không có GI để hệ thống
// tự nhận biết) — lưu theo khoá Item+Cust PO (đúng công thức key của planPairs, xem
// buildCombinedPlanCompareTable), CHỈ lưu mốc đã tick, không đổi số Chênh lệch thật đang hiển thị.
let sppManualOk = {};
const STORAGE_KEY_SPP_OK = 'tn5_dashboard_spp_ok_v1';
function sppOkKey(item, custpo){
  return String(item || '').toLowerCase() + '␟' + String(custpo || '').toLowerCase();
}
function toggleSppOk(item, custpo){
  const key = sppOkKey(item, custpo);
  if(sppManualOk[key]) delete sppManualOk[key];
  else sppManualOk[key] = { at: Date.now() };
  _localContOverridesDirty = true;
  saveStateToStorage();
  scheduleAutoSaveToCloud('contoverride', [STORAGE_KEY_SPP_OK], 'Đánh dấu Đủ hàng SPP thủ công');
  renderPlanPanel(); // renderCombinedPlanPanel() bên trong tự tính lại combinedPlanCache mới nhất
  renderSppPlanPopup(); // vẽ lại ngay nội dung popup (nếu đang mở) để thấy cập nhật tức thì, không phải đóng/mở lại
  if(typeof renderAlertsPanel === 'function') renderAlertsPanel(); // cập nhật luôn thẻ cảnh báo "Thiếu hàng theo kế hoạch"
}
document.addEventListener('change', (e) => {
  const cb = e.target.closest('input[data-spp-ok-item]');
  if(!cb) return;
  toggleSppOk(cb.dataset.sppOkItem, cb.dataset.sppOkPo);
});

function renderCombinedPlanPanel(){
  const rowEl = document.getElementById('plan-combined-row');
  const tableWrap = document.getElementById('plan-combined-table-wrap');
  const kpiEl = document.getElementById('plan-combined-kpi');
  const summaryTextEl = document.getElementById('plan-combined-summary-text');
  if(!rowEl || !tableWrap) return;

  const loadedTypes = PLAN_TYPES.filter(t => planData[t]);
  if(!loadedTypes.length){
    rowEl.style.display = 'none';
    combinedPlanCache = null;
    return;
  }
  rowEl.style.display = '';

  const combined = buildCombinedPlanCompareTable();
  combinedPlanCache = combined;

  const sppOkCount = combined.sppRows.filter(r => r.manualOk).length;
  if(kpiEl){
    kpiEl.innerHTML = `
      <div class="kpi"><div class="label">MÃ + PO SO SÁNH</div><div class="value">${fmt(combined.rows.length)}</div><div class="foot">Gộp ${loadedTypes.map(t=>'Plan '+t).join(' + ')}</div></div>
      <div class="kpi good"><div class="label">ĐỦ HÀNG</div><div class="value">${fmt(combined.okCount)}</div><div class="foot">Tồn (PASS) ≥ Tổng SL Plan</div></div>
      <div class="kpi accent"><div class="label">THIẾU HÀNG</div><div class="value">${fmt(combined.shortCount)}</div><div class="foot">Tồn (PASS) &lt; Tổng SL Plan</div></div>
      <div class="kpi"><div class="label">PO KHÔNG KHỚP</div><div class="value">${fmt(combined.poMismatchCount)}</div><div class="foot">⚠ Không thấy đúng PO trong tồn kho</div></div>
      <div class="kpi" id="spp-plan-kpi-tile" style="cursor:pointer;" title="Item No. không bắt đầu bằng số 0 — không có GI để tự nhận Pick xong, bấm để xem & tick tay">
        <div class="label">NHÓM SPP ▸</div><div class="value">${fmt(combined.sppRows.length)}</div><div class="foot">${fmt(sppOkCount)} đã tick Đủ hàng — bấm xem</div>
      </div>
    `;
  }
  if(summaryTextEl){
    summaryTextEl.innerHTML = `So sánh Tổng SL kế hoạch còn cần lấy (${loadedTypes.map(t=>'Plan '+t).join(' + ')}, đã trừ container Pick xong) vs SL tồn kho (theo Item + Cust PO) &nbsp; <span class="compare-summary"><span class="compare-badge ok">Đủ ${combined.okCount}</span> <span class="compare-badge short">Thiếu ${combined.shortCount}</span>${combined.poMismatchCount ? ` <span class="compare-badge warn">⚠ ${combined.poMismatchCount} PO không khớp tồn kho</span>` : ''}</span>`;
  }

  if(!combined.mainRows.length){
    tableWrap.innerHTML = `<div class="kho-empty" style="display:block;">Không có dữ liệu để so sánh (ngoài nhóm SPP — xem ô "Nhóm SPP" phía trên).</div>`;
    return;
  }

  const khoOrder = combined.khoOrder || [];
  const typeHead = loadedTypes.map(t => `<th style="text-align:right; color:${PLAN_COLORS[t]}">Plan ${t}</th>`).join('');
  const khoHead = khoOrder.map(k => `<th style="text-align:right">${k.replace('Kho ','')}</th>`).join('');
  const colCount = 3 + loadedTypes.length + khoOrder.length + 5;
  const bodyRows = combined.mainRows.map(r => combinedCompareRowHtml(r, loadedTypes, false)).join('');

  tableWrap.innerHTML = `
    <table class="plan-detail-table compare-table" data-colspan="${colCount}">
      <thead><tr>
        <th>Item No.</th><th>Cust PO</th>${typeHead}
        <th style="text-align:right">Tổng Plan</th>
        ${khoHead}
        <th style="text-align:right">Tổng tồn (PASS)</th>
        <th style="text-align:right">PASS</th>
        <th style="text-align:right">NG</th>
        <th style="text-align:right">Chênh lệch</th>
        <th>Trạng thái</th>
      </tr></thead>
      <tbody>${bodyRows}</tbody>
    </table>`;
}

// Container đã "Đã Load Xong" (dữ liệu Ship khớp Reference, SL Ship >= SL Plan container) — dùng
// CHUNG cho cả xuất Excel lẫn xuất HTML "Tổng hợp 3 Plan" (2 nơi đều cần bỏ các container này ra
// khỏi kết quả). Tính lại ĐÚNG công thức đang dùng ở cột "Trạng thái Loading" trên bảng Picking
// Status (renderContPickTable — xem "loadingHtml"/"shipPct"), gộp theo groupKey (type|cNo|loadDate|
// planTime) để lọc trực tiếp danh sách container của từng mã.
function computeLoadedDoneContainerKeys(){
  const keys = new Set();
  if(contShipData && contShipData.byRef.size){
    contPickAllRows.forEach(row => {
      const refs = String(row.csr || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
      let shipQty = 0, matched = false;
      refs.forEach(ref => { if(contShipData.byRef.has(ref)){ matched = true; shipQty += contShipData.byRef.get(ref); } });
      if(!matched || shipQty <= 0) return;
      const shipPct = row.planQty > 0 ? (shipQty / row.planQty * 100) : 0;
      if(shipPct >= 99.995) keys.add(`${row.type}|${row.cNo}|${row.loadDate}|${row.planTime}`);
    });
  }
  return keys;
}

// Đổi từ SheetJS (XLSX.*) sang ExcelJS cho riêng sheet "Tổng hợp 3 Plan" — SheetJS bản miễn phí không
// ghi được style (kẻ khung/tô nền), ExcelJS thì có (đã dùng sẵn ở các chỗ xuất Excel khác trong app,
// xem exportPickSlipToExcel()/ccBuildDaXacNhanSheetFromRecords() — dùng lại đúng quy ước màu/viền đó
// cho nhất quán). CHỈ đổi CÁCH DỰNG sheet, không đổi số liệu/logic tính toán ở đâu khác.
async function exportCombinedPlanToExcel(){
  const loadedTypes = PLAN_TYPES.filter(t => planData[t]);
  if(!loadedTypes.length) return;
  if(!LIB_EXCELJS_OK){
    alert('Không xuất được Excel: thư viện ExcelJS chưa tải được (cần Internet). Hãy mở file này bằng Chrome có kết nối mạng rồi thử lại.');
    return;
  }
  const combined = combinedPlanCache || buildCombinedPlanCompareTable();
  const khoOrder = combined.khoOrder || [];

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'TN5 Dashboard';
  workbook.created = new Date();

  const thin = { style:'thin', color:{ argb:'FFAAAAAA' } };
  const thick = { style:'medium', color:{ argb:'FF222222' } };
  const FILL_A = 'FFFFFFFF';
  const FILL_B = 'FFF6F6F6';

  // ===== Sheet 1: Tổng hợp 3 Plan — kẻ khung đầy đủ, viền đậm + tô nền xen kẽ phân theo TỪNG
  // CONTAINER (không theo mã nữa — 1 container có thể chở nhiều mã, các mã đó được nhóm lại cùng
  // nhau), xếp theo Ngày Load + Giờ Plan TĂNG DẦN, cột thông tin container đưa lên ĐẦU bảng. Mã nào
  // không thuộc container nào (chưa gán/không tìm thấy) rơi xuống cuối bảng. Dữ liệu lấy từ
  // buildItemContainerList() — đúng nội dung popup "Xem container" trên giao diện.
  const ws1 = workbook.addWorksheet('Tong hop 3 Plan'.slice(0,31));
  const contHeaders = ['Loại Plan', 'Ngày Load', 'Giờ Plan', 'Invoice', 'CSR'];
  const khoHeaderLabels = khoOrder.map(k => k.replace('Kho ', ''));
  // Cột "3A" (tổng tồn kho 3A) được TÁCH thành 3 cột SỐ liền nhau, thay vì hiện tổng gộp: "3A trệt"
  // (mọi locator kho 3A KHÔNG thuộc 2 dạng bên dưới), "3A lầu" (gộp cả lầu M1+M2), "3A Rack" (vị trí
  // Rack). Dùng buildItemLocatorDetail() — CÙNG hàm đang dùng cho sheet "Chi tiết vị trí" — lọc đúng
  // theo PO (hoặc mọi PO nếu anyPO) khớp với cách tính SL kho 3A trước đây. 2 dạng locator riêng của
  // kho 3A: "3AFG-M1xx"/"3AFG-M2xx" (lầu M1/M2) và "3A-<Chữ><Số>-T<Số>" (VD 3A-A17-T5, 3A-D1-T5 —
  // dãy/kệ rồi tới "T" + số tầng kệ) là hàng Rack.
  const itemHeaderParts = ['Item No.', 'Cust PO'];
  khoHeaderLabels.forEach(label => {
    if(label === '3A') itemHeaderParts.push('3A trệt', '3A lầu', '3A Rack');
    else itemHeaderParts.push(label);
  });
  itemHeaderParts.push('Tổng tồn (PASS+NG)', 'PASS', 'NG', 'SL Plan', 'CBM', 'Chênh lệch', 'Trạng thái');
  const itemHeaders = itemHeaderParts;
  const computeKho3AQty = (r) => {
    const locs = buildItemLocatorDetail(r.item, r.anyPO ? null : r.custpo, true);
    let treQty = 0, floorQty = 0, rackQty = 0;
    locs.forEach(l => {
      if(l.kho !== 'Kho 3A') return;
      const loc = String(l.locator || '');
      const qty = l.qty || 0;
      if(/^3AFG-M[12]/i.test(loc)){ floorQty += qty; return; }
      if(/^3A-[A-Z]\d+-T\d+/i.test(loc)){ rackQty += qty; return; }
      treQty += qty;
    });
    return { treQty, floorQty, rackQty };
  };
  const headers1 = [...contHeaders, ...itemHeaders];
  const nCols1 = headers1.length;
  // Cột theo từng kho (2B/3A/3B/DG1...) + "Tổng tồn (PASS+NG)" + "SL Plan" mỗi cột/nhóm cột 1 màu nền
  // RIÊNG (không đổi theo nhóm container) để phân biệt rõ — riêng nhóm 3 cột "3A trệt/lầu/Rack" dùng
  // CHUNG 1 màu vì cùng thuộc kho 3A — xác định vị trí qua headers1.indexOf() thay vì tính offset thủ
  // công, tránh lệch nếu sau này đổi thứ tự cột.
  const HIGHLIGHT_PALETTE = ['FFDCEEF5', 'FFE1F5DC', 'FFFAF3D0', 'FFEDE3F5', 'FFFCE0D6', 'FFE0F7F5', 'FFF5E0EA'];
  const highlightColorByCol = new Map();
  let highlightPaletteIdx = 0;
  const nextHighlightColor = () => HIGHLIGHT_PALETTE[(highlightPaletteIdx++) % HIGHLIGHT_PALETTE.length];
  khoHeaderLabels.forEach(label => {
    if(label === '3A'){
      const color = nextHighlightColor();
      ['3A trệt', '3A lầu', '3A Rack'].forEach(h => highlightColorByCol.set(headers1.indexOf(h) + 1, color));
    } else {
      highlightColorByCol.set(headers1.indexOf(label) + 1, nextHighlightColor());
    }
  });
  highlightColorByCol.set(headers1.indexOf('Tổng tồn (PASS+NG)') + 1, nextHighlightColor());
  highlightColorByCol.set(headers1.indexOf('SL Plan') + 1, nextHighlightColor());

  const headerRow1 = ws1.addRow(headers1);
  headerRow1.height = 20;
  headerRow1.eachCell((cell, colNumber) => {
    cell.font = { bold:true };
    cell.fill = { type:'pattern', pattern:'solid', fgColor:{ argb: highlightColorByCol.get(colNumber) || 'FFEFEFEF' } };
    cell.alignment = { vertical:'middle', horizontal:'center', wrapText:true };
    cell.border = { top:thick, bottom:thick, left:thin, right:thin };
  });
  ws1.getCell(1, 1).border = Object.assign({}, ws1.getCell(1,1).border, { left:thick });
  ws1.getCell(1, nCols1).border = Object.assign({}, ws1.getCell(1,nCols1).border, { right:thick });
  ws1.getCell(1, contHeaders.length + 1).border = Object.assign({}, ws1.getCell(1, contHeaders.length + 1).border, { left:thick });

  const colMaxLen1 = headers1.map(h => h.length);
  const trackWidth1 = (idx, text) => { const len = String(text==null?'':text).length; if(len > colMaxLen1[idx]) colMaxLen1[idx] = len; };

  const loadedDoneContainerKeys = computeLoadedDoneContainerKeys();

  // Dàn phẳng ra 1 dòng/(mã, container) — mã nào dùng nhiều container thì lặp lại đủ số dòng; mã nào
  // không có container nào thì vẫn giữ 1 dòng (cột container để trống), groupKey riêng theo mã đó để
  // không bị gộp nhầm với mã khác. Container CÙNG groupKey (cùng type+cNo+loadDate+planTime) LUÔN có
  // cùng sortKey (cùng ngày/giờ) nên sort ổn định vẫn giữ các mã của 1 container nằm liền nhau. Mã nào
  // MỌI container đều đã Load Xong thì bỏ HẲN (không rơi vào nhóm "không có container" — 2 trường hợp
  // khác nghĩa nhau: 1 bên là chưa gán container, 1 bên là container đã xong việc).
  const exportEntries = [];
  combined.rows.forEach(r => {
    const allContainers = buildItemContainerList(r.item, r.anyPO ? '' : r.custpo);
    const containers = allContainers.filter(c => !loadedDoneContainerKeys.has(`${c.type}|${c.cNo}|${c.loadDate}|${c.planTime}`));
    if(containers.length){
      containers.forEach(c => exportEntries.push({
        r, c,
        groupKey: `${c.type}|${c.cNo}|${c.loadDate}|${c.planTime}`,
        sortKey: ovParseDateTimeSortKey(c.loadDate, c.planTime)
      }));
    } else if(!allContainers.length){
      exportEntries.push({ r, c: null, groupKey: `__nocont__${r.item.toLowerCase()}␟${r.custpo.toLowerCase()}`, sortKey: Infinity });
    }
  });
  exportEntries.sort((a,b) => (a.sortKey - b.sortKey) || (a.groupKey < b.groupKey ? -1 : a.groupKey > b.groupKey ? 1 : 0));

  let groupIndex = -1;
  let prevGroupKey = null;
  exportEntries.forEach(({ r, c, groupKey }) => {
    const contValues = c
      ? [c.type, c.loadDate, c.planTime, c.invoice || '—', c.csr || '—']
      : ['—', '—', '—', '—', '—'];
    const kho3A = computeKho3AQty(r);
    const itemValues = [
      r.item,
      r.anyPO ? 'Bất kỳ PO' : r.custpo + (r.poMismatch ? ' (PO không khớp tồn kho)' : ''),
    ];
    (r.khoQtys || []).forEach((qty, i) => {
      if(khoHeaderLabels[i] === '3A') itemValues.push(kho3A.treQty, kho3A.floorQty, kho3A.rackQty);
      else itemValues.push(qty);
    });
    itemValues.push(r.pass + r.ng, r.pass, r.ng, c ? c.qty : '—', c ? Math.round((c.cbm || 0) * 100) / 100 : '—', r.diff, (r.diff >= 0 || r.manualOk) ? 'Đủ' : 'Thiếu');
    const rowValues = [...contValues, ...itemValues];
    rowValues.forEach((v,i) => trackWidth1(i, v));
    const isGroupFirst = groupKey !== prevGroupKey;
    if(isGroupFirst) groupIndex++;
    prevGroupKey = groupKey;
    const fillColor = groupIndex % 2 === 0 ? FILL_A : FILL_B;
    const leftAlignCols = new Set([contHeaders.length + 1, contHeaders.length + 2]); // Item No./Cust PO
    const row = ws1.addRow(rowValues);
    row.eachCell((cell, colNumber) => {
      cell.fill = { type:'pattern', pattern:'solid', fgColor:{ argb: highlightColorByCol.get(colNumber) || fillColor } };
      cell.alignment = { vertical:'middle', horizontal: leftAlignCols.has(colNumber) ? 'left' : 'center' };
      cell.border = {
        top: isGroupFirst ? thick : thin,
        bottom: thin,
        left: colNumber === 1 ? thick : (colNumber === contHeaders.length + 1 ? thick : thin),
        right: colNumber === nCols1 ? thick : thin
      };
    });
  });
  if(ws1.lastRow) ws1.lastRow.eachCell(cell => { cell.border = Object.assign({}, cell.border, { bottom: thick }); });

  const colCapsByHeader1 = { 'Item No.': [14,16], 'Cust PO': [16,26], 'Invoice': [10,14], 'CSR': [10,14] };
  headers1.forEach((h,i) => {
    const [minW, maxW] = colCapsByHeader1[h] || [8,14];
    ws1.getColumn(i+1).width = Math.min(Math.max(colMaxLen1[i] + 2, minW), maxW);
  });
  ws1.views = [{ state:'frozen', ySplit:1 }];

  // ===== Sheet 2: Chi tiết vị trí tồn kho — GIỮ NGUYÊN dữ liệu/logic như bản cũ (chỉ đổi cách dựng
  // sang ExcelJS cho khớp cùng workbook, không thêm/bớt/đổi nội dung gì).
  const ws2 = workbook.addWorksheet('Chi tiet vi tri'.slice(0,31));
  const detailHeader = ['OQC', 'Kho', 'Item No.', 'Cust PO (tồn kho)', 'Locator', 'SL tồn'];
  const detailHeaderRow = ws2.addRow(detailHeader);
  detailHeaderRow.eachCell(cell => { cell.font = { bold:true }; });
  combined.rows.forEach(r => {
    const locs = buildItemLocatorDetail(r.item, null, true); // loại vị trí "Prod" khỏi Excel Tổng hợp 3 Plan
    if(!locs.length){
      ws2.addRow(['', '(khong co ton kho)', r.item, '', '', 0]);
    } else {
      locs.forEach(l => ws2.addRow([l.oqc, l.kho.replace('Kho ', ''), r.item, l.custpo, l.locator, l.qty]));
    }
  });
  [14, 14, 14, 14, 18, 14].forEach((w,i) => { ws2.getColumn(i+1).width = w; });

  const pad = n => String(n).padStart(2,'0');
  const now = new Date();
  const stamp = `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}`;
  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer], { type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `Tong_hop_3_Plan_vs_Ton_kho_${stamp}.xlsx`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

const btnExportCombinedPlan = document.getElementById('btn-export-combined-plan');
if(btnExportCombinedPlan) btnExportCombinedPlan.addEventListener('click', exportCombinedPlanToExcel);

function buildTopItemsBarHtml(topItems, color){
  if(!topItems || !topItems.length) return '<div class="kho-empty" style="display:block; padding:14px 0;">Không có dữ liệu</div>';
  const maxQty = Math.max(...topItems.map(i => i[1]));
  return topItems.map(([item, qty]) => {
    const w = maxQty ? (qty / maxQty * 100) : 0;
    return `<div class="simple-bar-row">
      <span class="simple-bar-label" title="${item}">${item}</span>
      <div class="simple-bar-track"><div class="simple-bar-fill" style="width:${w}%; background:${color}"></div></div>
      <span class="simple-bar-value">${fmt(qty)}</span>
    </div>`;
  }).join('');
}

function oqcBadge(oqc){
  const v = (oqc || '').toUpperCase();
  const cls = v === 'PASS' ? 'pass' : (v === 'NG' ? 'ng' : 'other');
  return `<span class="oqc-badge ${cls}">${oqc || '—'}</span>`;
}

/* Mỗi dòng / cụm cách nhau bởi dấu phẩy, chấm phẩy, xuống dòng là 1 "nhóm tìm" độc lập (OR với nhau).
   Trong 1 nhóm, các từ cách nhau bằng khoảng trắng phải khớp ĐỒNG THỜI (AND) trên cùng 1 dòng dữ liệu
   — ví dụ "CR0163815 095079952" sẽ tìm đúng dòng có cả CSR/Ref lẫn Item No. đó, không phải khớp riêng lẻ. */
function parseMultiCodes(text){
  const lines = text.split(/[,;\n]+/);
  const groups = lines
    .map(l => [...new Set(l.trim().toLowerCase().split(/\s+/).filter(Boolean))])
    .filter(g => g.length);
  return groups;
}
function multiGroupMatch(groups, hay){
  return groups.some(g => g.every(tok => hay.includes(tok)));
}

/* Dữ liệu gốc theo dòng (item, custpo, locator, oqc, qty, gi, lot, pallet, dt, buyer, ref).
   File .xlsx/.csv mới tải lên sẽ có raw_rows đầy đủ; dữ liệu mặc định (DEFAULT_DATA) không
   lưu sẵn các trường GI/Lot/Pallet/Ngày nhận nên suy ra dòng gần đúng từ kho_detail (các
   trường đó sẽ hiển thị "—"). */
function buildRawRowsFromKhoDetail(data){
  const out = [];
  for(const kho of Object.keys(data.kho_detail || {})){
    for(const row of data.kho_detail[kho]){
      const [item, custpo, locator, oqc, qty, ref] = row;
      out.push([kho, item, custpo, locator, oqc, qty, '', '', '', '', '', ref || '']);
    }
  }
  return out;
}
function getRawRows(data){
  if(!data) return [];
  if(data.raw_rows && data.raw_rows.length) return data.raw_rows;
  return buildRawRowsFromKhoDetail(data);
}

const RAW_KEY_IDX = {kho:0, item:1, custpo:2, locator:3, oqc:4, qty:5, gi:6, lot:7, pallet:8, dt:9, buyer:10, ref:11};

/* ============ SƠ ĐỒ KHO 3B ============
   Mỗi dòng dữ liệu gốc (raw_rows) tương ứng 1 dòng GI No. trong file tồn kho => tính là 1 pallet.
   Gom theo Locator trong "Kho 3B", giới hạn hiển thị tối đa 26 pallet/vị trí (vượt quá vẫn tính max). */
const WH3B_MAX_PALLET = 26;

// CACHE theo tham chiếu currentData — hàm này được gọi lại MỖI KÝ TỰ gõ vào ô tìm kiếm sơ đồ kho (xem
// whApplySearchFilter()), dù dữ liệu tồn kho không đổi giữa các lần gõ đó; quét lại toàn bộ raw_rows
// mỗi lần gây giật khi gõ tìm kiếm trên bộ dữ liệu lớn.
let _sodo3bByLocatorCache = null, _sodo3bByLocatorForData = null;
function computeSodo3bByLocator(){
  if(_sodo3bByLocatorForData === currentData && _sodo3bByLocatorCache) return _sodo3bByLocatorCache;
  const map = {};
  if(currentData){
    const raw = getRawRows(currentData);
    for(const row of raw){
      if(row[RAW_KEY_IDX.kho] !== 'Kho 3B') continue;
      const locator = row[RAW_KEY_IDX.locator] || '—';
      (map[locator] || (map[locator] = [])).push(row);
    }
  }
  _sodo3bByLocatorCache = map;
  _sodo3bByLocatorForData = currentData;
  return map;
}

function sodo3bLocatorSortKey(loc){
  const s = String(loc || '').toUpperCase();
  let m;
  if((m = s.match(/^D3B-FG-A(\d+)$/))) return [0, parseInt(m[1], 10), s];
  if((m = s.match(/^D3B-E27-(\d+)$/))) return [2, parseInt(m[1], 10), s];
  if((m = s.match(/^3B-PICK-?(\d+)?$/))) return [4, m[1] ? parseInt(m[1], 10) : 0, s];
  if(s.startsWith('D3B-FG-')) return [1, 0, s];
  if(s.startsWith('D3B-')) return [3, 0, s];
  return [5, 0, s];
}

/* Sức chứa tối đa (pallet) có thể ghi đè theo TỪNG locator (nút bánh răng trên mỗi ô) — áp
   dụng chung cho cả Sơ đồ kho 3B và Sơ đồ Rack 3A, lưu qua LS nên cũng được đồng bộ theo cơ chế
   Lưu/Cloud sẵn có. */
const WH_CAP_OVERRIDE_KEY = 'tn5_wh_cap_override_v1';
// CACHE lại kết quả JSON.parse theo đúng chuỗi thô vừa đọc được — whApplyCapOverride() (và
// computeLocatorBoxStats()) gọi whLoadCapOverrides() 1 LẦN CHO MỖI VỊ TRÍ khi vẽ sơ đồ kho (VD Rack 3A
// có ~240 vị trí), dù dữ liệu override HIẾM KHI đổi giữa các lần gọi đó trong cùng 1 lượt vẽ — trước
// đây mỗi lần đều JSON.parse() lại từ đầu. So sánh đúng CHUỖI THÔ (không phải cờ thủ công) nên vẫn
// bắt được thay đổi tới từ nơi khác ghi vào cùng khoá này (VD đồng bộ Cloud/thiết bị khác), không lo
// bị "cache cũ".
let _whCapOverridesCache = null;
let _whCapOverridesRawCache = undefined;
function whLoadCapOverrides(){
  try{
    const raw = LS.getItem(WH_CAP_OVERRIDE_KEY);
    if(raw === _whCapOverridesRawCache && _whCapOverridesCache) return _whCapOverridesCache;
    _whCapOverridesRawCache = raw;
    _whCapOverridesCache = raw ? JSON.parse(raw) : {};
    return _whCapOverridesCache;
  }catch(e){ return {}; }
}
function whSaveCapOverrides(obj){
  LS.setItem(WH_CAP_OVERRIDE_KEY, JSON.stringify(obj));
}
// Áp số ghi đè (nếu có) cho 1 locator lên trên 1 số sức chứa gốc/mặc định — dùng chung ở cả trang
// "Sơ đồ kho" (nút bánh răng) lẫn các panel "Tổng quan sức chứa" ở trang Overview, để 2 nơi luôn
// khớp nhau: sửa sức chứa 1 locator ở Sơ đồ kho sẽ tự phản ánh sang Overview (chỉ với những
// locator đang thực sự được TÍNH vào Utilization của kho đó — không tự thêm locator mới vào).
function whApplyCapOverride(loc, baseCap){
  const overrides = whLoadCapOverrides();
  return (overrides[loc] !== undefined && overrides[loc] !== null) ? overrides[loc] : baseCap;
}

/* ============ HEATMAP tô màu SƠ ĐỒ KHO ============
   Chế độ xem thêm (ngoài 4 mức Trống/Thấp/Vừa/Đầy mặc định vẫn giữ nguyên): tô cả nền ô theo
   - 'qty': mật độ lấp đầy (giống % thanh fill hiện có, chỉ là tô nổi bật hơn lên cả ô)
   - 'oqc': tỉ lệ PASS/NG theo SL tại vị trí đó (2 màu đối lập, giữa là trung tính)
   Áp dụng CHUNG cho cả 3 kho (3B/3A/2B) và cả 2 kiểu lưới (mặc định + tuỳ chỉnh) vì đều đi qua
   buildLocatorBoxHtml() — chỉ là 1 tuỳ chọn hiển thị trên máy, không phải dữ liệu nghiệp vụ nên chỉ
   lưu localStorage, không đẩy lên Cloud. */
const STORAGE_KEY_KHO_HEATMAP = 'tn5_kho_heatmap_mode_v1';
const KHO_HEATMAP_MODES = ['off', 'qty', 'oqc'];
let khoHeatmapMode = 'off';
try{
  const savedHeatmapMode = LS.getItem(STORAGE_KEY_KHO_HEATMAP);
  if(KHO_HEATMAP_MODES.includes(savedHeatmapMode)) khoHeatmapMode = savedHeatmapMode;
}catch(e){}

function khoHeatmapBtnLabel(){
  if(khoHeatmapMode === 'qty') return '🌡️ Heatmap: Mật độ';
  if(khoHeatmapMode === 'oqc') return '🌡️ Heatmap: PASS/NG';
  return '🌡️ Heatmap: Tắt';
}
function khoLegendHtml(){
  if(khoHeatmapMode === 'qty'){
    return `<span>Heatmap — mật độ lấp đầy theo vị trí:</span>
      <span style="display:inline-flex; align-items:center; gap:6px;">
        <i style="background:var(--panel-2)"></i>Trống
        <span style="width:64px; height:10px; border-radius:5px; border:1px solid var(--line); display:inline-block; background:linear-gradient(90deg, var(--panel-2), var(--teal));"></span>
        Đầy
      </span>`;
  }
  if(khoHeatmapMode === 'oqc'){
    return `<span>Heatmap — tỉ lệ PASS/NG theo SL:</span>
      <span style="display:inline-flex; align-items:center; gap:6px;">
        <span style="color:var(--red)">100% NG</span>
        <span style="width:90px; height:10px; border-radius:5px; border:1px solid var(--line); display:inline-block; background:linear-gradient(90deg, var(--red), var(--line), var(--teal));"></span>
        <span style="color:var(--teal)">100% PASS</span>
      </span>`;
  }
  return `<span><i style="background:var(--muted-2)"></i>Trống (0 pallet)</span>
    <span><i style="background:var(--teal)"></i>Thấp (&lt; 50%)</span>
    <span><i style="background:var(--amber-bright)"></i>Vừa (50–79%)</span>
    <span><i style="background:var(--red)"></i>Đầy / gần đầy (≥ 80%)</span>`;
}
function khoRenderHeatmapControls(){
  Object.values(KHO_CUSTOM_GRID_CONFIG).forEach(cfg => {
    const btn = document.getElementById(cfg.heatmapBtn);
    if(btn){ btn.textContent = khoHeatmapBtnLabel(); btn.classList.toggle('active', khoHeatmapMode !== 'off'); }
    const legendEl = document.getElementById(cfg.legend);
    if(legendEl) legendEl.innerHTML = khoLegendHtml();
  });
}
function khoHeatmapCycle(){
  const idx = KHO_HEATMAP_MODES.indexOf(khoHeatmapMode);
  khoHeatmapMode = KHO_HEATMAP_MODES[(idx + 1) % KHO_HEATMAP_MODES.length];
  try{ LS.setItem(STORAGE_KEY_KHO_HEATMAP, khoHeatmapMode); }catch(e){}
  khoRenderHeatmapControls();
  renderSodo3B();
}

/* Vẽ 1 ô locator (dùng chung cho Sơ đồ kho 3B và Sơ đồ Rack 3A) — gồm: tên, số pallet/sức chứa,
   thanh fill màu theo mức lấp đầy, nút bánh răng để ghi đè sức chứa tối đa riêng cho vị trí đó,
   và badge "NG" nếu vị trí đang có hàng NG. */
function computeLocatorBoxStats(loc, rows, defaultMaxPallet){
  const overrides = whLoadCapOverrides();
  const maxPallet = overrides[loc] || defaultMaxPallet;
  const count = rows.length;
  const cappedForFill = Math.min(count, maxPallet);
  const pct = Math.round(cappedForFill / maxPallet * 100);
  let level;
  if(cappedForFill === 0) level = 'empty';
  else if(cappedForFill < maxPallet * 0.5) level = 'low';
  else if(cappedForFill < maxPallet * 0.8) level = 'mid';
  else level = 'full';
  // Tổng SL (không phải số pallet) + tách PASS/NG theo SL — dùng cho chế độ Heatmap "Tỉ lệ PASS/NG"
  // (xem khoHeatmapMode) và cho tooltip; KHÔNG ảnh hưởng gì tới count/pct/level ở trên (vẫn tính theo
  // số pallet như cũ, để không đổi hành vi hiện có khi Heatmap đang Tắt).
  let qtyTotal = 0, passQty = 0, ngQty = 0;
  rows.forEach(r => {
    const q = Number(r[RAW_KEY_IDX.qty]) || 0;
    qtyTotal += q;
    const oqc = String(r[RAW_KEY_IDX.oqc] || '').toUpperCase();
    if(oqc === 'PASS') passQty += q;
    else if(oqc === 'NG') ngQty += q;
  });
  const gradedQty = passQty + ngQty;
  const passRatio = gradedQty > 0 ? passQty / gradedQty : null;
  const hasNG = ngQty > 0;
  return { count, maxPallet, pct, level, hasNG, qtyTotal, passQty, ngQty, passRatio };
}

// Nền tô màu Heatmap cho 1 ô — trộn thẳng vào màu nền hiện có (--panel-2) hoặc màu viền trung tính
// (--line) bằng color-mix() nên TỰ đổi đúng theo Sáng/Tối/theme đang chọn, không cần định nghĩa thêm
// bảng màu riêng cho từng theme. Dùng "in oklab" (không phải oklch) — trộn xám/viền với đỏ theo oklch
// (toạ độ cực) có thể "vòng qua" tím ở các mức pha thấp vì góc màu (hue) không ổn định quanh điểm gần
// như không màu, dễ nhầm với màu tím thương hiệu (--violet) đang dùng cho hành động chính; oklab trộn
// theo toạ độ thẳng (a*/b*) nên không bị lỗi này. Giới hạn mức trộn tối đa 85% để chữ/icon trong ô vẫn
// đủ tương phản, không cần tính contrast riêng theo từng ô.
const KHO_HEATMAP_MAX_MIX = 85;
function khoHeatmapCellStyle(stats){
  if(khoHeatmapMode === 'qty'){
    if(stats.count === 0) return '';
    const pct = Math.max(0, Math.min(KHO_HEATMAP_MAX_MIX, stats.pct));
    return ` style="background:color-mix(in oklab, var(--panel-2), var(--teal) ${pct}%);"`;
  }
  if(khoHeatmapMode === 'oqc'){
    if(stats.passRatio === null) return '';
    const d = (stats.passRatio - 0.5) * 2; // -1 (toàn NG) .. 1 (toàn PASS)
    const mixPct = Math.round(Math.min(KHO_HEATMAP_MAX_MIX, Math.abs(d) * 100));
    const hue = d >= 0 ? 'var(--teal)' : 'var(--red)';
    return ` style="background:color-mix(in oklab, var(--line), ${hue} ${mixPct}%);"`;
  }
  return '';
}

function buildLocatorBoxHtml(loc, rows, defaultMaxPallet, extraClass){
  const stats = computeLocatorBoxStats(loc, rows, defaultMaxPallet);
  const { count, maxPallet, pct, level, hasNG, qtyTotal, passQty, ngQty } = stats;
  const overNote = count > maxPallet
    ? `<span class="wh3b-over" title="Vượt sức chứa chuẩn ${maxPallet} pallet/vị trí">VƯỢT</span>`
    : '';
  const ngBadge = hasNG ? `<span class="wh3b-ng-badge" title="Vị trí này đang có hàng NG">NG</span>` : '';
  const heatClass = khoHeatmapMode === 'off' ? '' : ' heat-' + khoHeatmapMode;
  const heatStyle = khoHeatmapCellStyle(stats);
  const mainTitle = count > 0
    ? `${loc} — SL: ${fmt(qtyTotal)} (PASS ${fmt(passQty)} / NG ${fmt(ngQty)}) · Bấm để xem chi tiết`
    : `Bấm để xem chi tiết pallet tại ${loc}`;
  return {
    level,
    count,
    html: `
    <div class="wh3b-box lvl-${level}${heatClass}${extraClass ? ' ' + extraClass : ''}" data-locator="${escAttr(loc)}"${heatStyle}>
      <button type="button" class="wh3b-box-gear" data-locator="${escAttr(loc)}" data-default-max="${defaultMaxPallet}" title="Chỉnh sức chứa tối đa (pallet) cho vị trí này">
        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"/></svg>
      </button>
      <button type="button" class="wh3b-box-main" data-locator="${escAttr(loc)}" title="${escAttr(mainTitle)}">
        <span class="wh3b-box-name">${escHtml(loc)}${ngBadge}</span>
        <span class="wh3b-box-count">${fmt(count)}<span class="wh3b-box-max">/${fmt(maxPallet)}</span>${overNote}</span>
        <span class="wh3b-box-fill"><span class="wh3b-box-fill-bar" style="width:${pct}%"></span></span>
      </button>
    </div>`
  };
}

/* Bố cục thực tế của Kho 3B, tách thành 4 khối màu riêng biệt:
   1) D3B-FG-PROD — 1 khối riêng, 1 ô full-width.
   2) A01 → A33 — 1 khối riêng, 2 cột so le: cột trái A01 (trên) → A15 (dưới), cột phải bắt đầu
      A16 ở hàng NGANG với A15 (dưới cùng), đếm lên tới A33 (trên cùng).
   3) Picking (3B-PICK-01 → 05) — 1 khối riêng, 5 ô cùng 1 hàng.
   4) D3B-Loading — 1 khối riêng, 1 ô full-width. */
function renderSodo3bBlocks(){
  const grid = document.getElementById('sodo3b-grid');
  const summaryEl = document.getElementById('wh3b-summary');
  const detailWrap = document.getElementById('sodo3b-detail');
  if(!grid) return;

  const map = computeSodo3bByLocator();
  if(detailWrap) detailWrap.innerHTML = '';

  if(!Object.keys(map).length){
    grid.innerHTML = `<div class="wh3b-empty">Không có dữ liệu tồn kho cho Kho 3B trong dữ liệu hiện tại.</div>`;
    if(summaryEl) summaryEl.innerHTML = '';
    return;
  }

  const leftLocators = [];
  for(let n=1;n<=15;n++) leftLocators.push('D3B-FG-A' + String(n).padStart(2,'0'));
  const rightLocators = [];
  for(let n=33;n>=16;n--) rightLocators.push('D3B-FG-A' + String(n).padStart(2,'0'));
  const rowCount = Math.max(leftLocators.length, rightLocators.length);
  const leftOffset = rowCount - leftLocators.length;
  const pickLocators = [];
  for(let n=1;n<=5;n++) pickLocators.push('3B-PICK-' + String(n).padStart(2,'0'));

  let totalPallets = 0, fullCount = 0, realLocatorCount = 0;
  function box(loc, extraClass){
    const rows = map[loc] || [];
    const b = buildLocatorBoxHtml(loc, rows, WH3B_MAX_PALLET, extraClass);
    totalPallets += b.count;
    if(b.level === 'full') fullCount++;
    realLocatorCount++;
    return b.html;
  }

  const prodHtml = `<div class="wh3b-block wh3b-block-prod"><div class="wh3b-subgrid wh3b-subgrid-1col">${box('D3B-FG-PROD', '')}</div></div>`;

  let mainCells = '';
  for(let i=0;i<rowCount;i++){
    const leftLoc = i >= leftOffset ? leftLocators[i - leftOffset] : null;
    const rightLoc = rightLocators[i] || null;
    mainCells += leftLoc ? box(leftLoc, '') : `<div class="wh3b-box-blank"></div>`;
    mainCells += rightLoc ? box(rightLoc, '') : `<div class="wh3b-box-blank"></div>`;
  }
  const mainHtml = `<div class="wh3b-block wh3b-block-main"><div class="wh3b-subgrid wh3b-subgrid-2col">${mainCells}</div></div>`;

  const pickHtml = `<div class="wh3b-block wh3b-block-pick"><div class="wh3b-subgrid wh3b-subgrid-5col">${pickLocators.map(l => box(l, '')).join('')}</div></div>`;

  const loadingHtml = `<div class="wh3b-block wh3b-block-loading"><div class="wh3b-subgrid wh3b-subgrid-1col">${box('D3B-Loading', '')}</div></div>`;

  const knownSet = new Set(['D3B-FG-PROD', 'D3B-Loading', ...pickLocators, ...leftLocators, ...rightLocators]);
  const others = Object.keys(map).filter(l => !knownSet.has(l)).sort((a, b2) => {
    const ka = sodo3bLocatorSortKey(a), kb = sodo3bLocatorSortKey(b2);
    for(let i=0;i<ka.length;i++){
      if(ka[i] === kb[i]) continue;
      return typeof ka[i] === 'string' ? ka[i].localeCompare(kb[i]) : ka[i] - kb[i];
    }
    return 0;
  });
  const othersHtml = others.length
    ? `<div class="wh3b-block"><div class="wh3b-subgrid" style="grid-template-columns:repeat(auto-fill, minmax(126px, 1fr));">${others.map(l => box(l, '')).join('')}</div></div>`
    : '';

  grid.innerHTML = prodHtml + mainHtml + pickHtml + loadingHtml + othersHtml;

  // Lưu lại danh sách + dữ liệu "ngoài sơ đồ" để nút cảnh báo góc panel dùng khi bấm vào.
  const outsideRows = [];
  others.forEach(loc => (map[loc] || []).forEach(r => outsideRows.push(r)));
  sodo3bOutsideData = { locators: others, rows: outsideRows };
  const warnEl = document.getElementById('wh3b-outside-warning');
  if(warnEl){
    if(others.length){
      warnEl.style.display = 'flex';
      warnEl.innerHTML = `⚠ ${fmt(others.length)} vị trí ngoài sơ đồ · ${fmt(outsideRows.length)} pallet`;
    } else {
      warnEl.style.display = 'none';
    }
  }

  if(summaryEl){
    summaryEl.innerHTML = `
      <div><b>${realLocatorCount}</b><span>Vị trí (locator)</span></div>
      <div><b>${fmt(totalPallets)}</b><span>Tổng pallet (dòng GI No.)</span></div>
      <div><b>${fullCount}</b><span>Vị trí đầy / gần đầy (≥ 80%)</span></div>
    `;
  }
}
let sodo3bOutsideData = { locators: [], rows: [] };

/* ============ GRID TUỲ CHỈNH CHUNG cho 3B / 3A / 2B ============
   Dữ liệu locator vẫn lấy trực tiếp từ currentData. Grid chỉ lưu cách bố trí hiển thị.
   Có thể thêm/sửa/xoá, đổi kích thước và KÉO TRỰC TIẾP locator để di chuyển. */
let khoGridLayouts = {}; // { 'Kho 3B'|'Kho 3A'|'Kho 2B': { rows, cols, cells:[...] } }
const STORAGE_KEY_KHO_GRID = 'tn5_dashboard_kho_grid_v1';

// Cờ tick (✓) của bảng "Chuyển pallet (Transfer)" ở trang Transaction — đánh dấu dòng nào đã kiểm
// tra xong, giữ được qua lần tải file Transaction mới (KHÔNG khoá theo Reference/Chuyến — 2 giá trị
// này đổi theo từng file, đánh số lại từ đầu mỗi lần — mà khoá theo "hình dạng" chuyến hàng: Kho
// xuất + Menu Name + Item + Locator xuất + Locator đến + User, xem txTransferRowKey()). Đây là kiểu
// tick đơn giản, không có ý nghĩa nghiệp vụ gì khác ngoài giúp người dùng tự đánh dấu đã xem.
let txTransferChecked = {}; // { rowKey: true }
const STORAGE_KEY_TX_TRANSFER_CHECKED = 'tn5_dashboard_tx_transfer_checked_v1';
function txTransferRowKey(r){
  return [r.khoXuat, r.menuName, r.item, r.locatorXuat, r.locatorDen, r.user].map(v => String(v==null?'':v)).join('||');
}
let sodo3bGridMode = false;
const khoCustomGridMode = { 'Kho 3B': false, 'Kho 3A': false, 'Kho 2B': false };
let _localKhoGridDirty = false;
let _khoGridEditingCellId = null;
let _khoGridActiveKho = 'Kho 3B';
let _khoGridDragState = null;
let _khoGridSuppressClick = false;
let _khoGridResizeState = null; // trạng thái kéo-thả resize viền ô (khác _khoGridDragState là kéo di chuyển cả ô)

// Chọn nhiều ô (Ctrl+Click / kéo chuột vùng chọn) + Cắt/Sao chép/Dán (Ctrl+X/C/V) trên grid tuỳ chỉnh.
// _khoGridSelection lưu vị trí (KHÔNG lưu id ô) dạng "hàng,cột" — dùng vị trí (không dùng id) vì cả
// ô đã có locator LẪN ô trống ("+") đều có thể được chọn (ô trống chọn để làm "đích dán"), và vị trí
// top-left của 1 ô đã có locator là đủ để xác định DUY NHẤT ô đó (không có 2 ô nào chồng lên nhau).
let _khoGridSelection = new Set(); // Set<"row,col">
let _khoGridSelectionKho = null; // chọn chỉ có ý nghĩa trong ĐÚNG 1 kho tại 1 thời điểm
let _khoGridClipboard = null; // { kho, cells: [{locator, rowSpan, colSpan, rowOffset, colOffset}] } — rowOffset/colOffset tính từ góc trên-trái của vùng đã chọn lúc Sao chép/Cắt
let _khoGridMarquee = null; // trạng thái đang kéo chuột vẽ vùng chọn hình chữ nhật

function khoGridClearSelection(){
  _khoGridSelection.clear();
  _khoGridSelectionKho = null;
}
function khoGridSelectionKey(row,col){ return row+','+col; }
function khoGridToggleSelect(kho,row,col){
  if(_khoGridSelectionKho && _khoGridSelectionKho!==kho) _khoGridSelection.clear();
  _khoGridSelectionKho = kho;
  const key = khoGridSelectionKey(row,col);
  if(_khoGridSelection.has(key)) _khoGridSelection.delete(key);
  else _khoGridSelection.add(key);
}
// Toạ độ góc trên-trái (hàng nhỏ nhất, cột nhỏ nhất) của toàn bộ vùng đang chọn — dùng làm "điểm neo"
// khi Sao chép/Cắt (tính offset từng ô so với góc này) và khi Dán (vị trí đích = neo + offset).
function khoGridSelectionAnchor(){
  if(!_khoGridSelection.size) return null;
  let minRow=Infinity, minCol=Infinity;
  _khoGridSelection.forEach(key => {
    const [r,c] = key.split(',').map(Number);
    if(r<minRow) minRow=r;
    if(c<minCol) minCol=c;
  });
  return { row:minRow, col:minCol };
}

const KHO_CUSTOM_GRID_CONFIG = {
  'Kho 3B': {
    defaultRows:5, defaultCols:5, defaultMax:WH3B_MAX_PALLET,
    modeBtn:'sodo3b-grid-mode-toggle', settingsBtn:'sodo3b-grid-settings-btn', copyBtn:'sodo3b-grid-copy-btn',
    heatmapBtn:'sodo3b-heatmap-toggle', legend:'sodo3b-legend',
    defaultGrid:'sodo3b-grid', customGrid:'sodo3b-custom-grid', note:'sodo3b-custom-grid-note', hint:null,
    search:'sodo3b-search', pass:'sodo3b-oqc-pass', ng:'sodo3b-oqc-ng', detail:'sodo3b-detail',
    compute:computeSodo3bByLocator
  },
  'Kho 3A': {
    defaultRows:10, defaultCols:10, defaultMax:2,
    modeBtn:'rack3a-grid-mode-toggle', settingsBtn:'rack3a-grid-settings-btn', copyBtn:'rack3a-grid-copy-btn',
    heatmapBtn:'rack3a-heatmap-toggle', legend:'rack3a-legend',
    defaultGrid:'rack3a-grid', customGrid:'rack3a-custom-grid', note:'rack3a-custom-grid-note', hint:'rack3a-drag-hint',
    search:'rack3a-search', pass:'rack3a-oqc-pass', ng:'rack3a-oqc-ng', detail:'rack3a-detail',
    compute:computeRack3AByLocator
  },
  'Kho 2B': {
    defaultRows:10, defaultCols:10, defaultMax:24,
    modeBtn:'sodo2b-grid-mode-toggle', settingsBtn:'sodo2b-grid-settings-btn', copyBtn:'sodo2b-grid-copy-btn',
    heatmapBtn:'sodo2b-heatmap-toggle', legend:'sodo2b-legend',
    defaultGrid:'sodo2b-grid', customGrid:'sodo2b-custom-grid', note:'sodo2b-custom-grid-note', hint:'sodo2b-drag-hint',
    search:'sodo2b-search', pass:'sodo2b-oqc-pass', ng:'sodo2b-oqc-ng', detail:'sodo2b-detail',
    compute:computeSodo2bByLocator
  }
};

// Vẽ nhãn nút + chú thích Heatmap NGAY khi script chạy (nút đã có sẵn trong index.html lúc này —
// app.js nằm cuối <body>) — để đúng luôn trạng thái đã lưu (localStorage) từ trước khi cần bấm gì.
khoRenderHeatmapControls();

// Danh sách ĐẦY ĐỦ vị trí (locator) của sơ đồ MẶC ĐỊNH từng kho — cố định theo đúng bố cục layout
// gốc (KHÁC với compute...ByLocator() ở trên, vốn chỉ liệt kê vị trí đang CÓ tồn kho thật) — dùng cho
// nút "📋 Copy từ sơ đồ mặc định" ở grid tuỳ chỉnh.
function khoGridDefaultLocatorsFor(khoLabel){
  if(khoLabel === 'Kho 3B'){
    const left = []; for(let n=1;n<=15;n++) left.push('D3B-FG-A' + String(n).padStart(2,'0'));
    const right = []; for(let n=33;n>=16;n--) right.push('D3B-FG-A' + String(n).padStart(2,'0'));
    const pick = []; for(let n=1;n<=5;n++) pick.push('3B-PICK-' + String(n).padStart(2,'0'));
    return ['D3B-FG-PROD', 'D3B-Loading', ...pick, ...left, ...right];
  }
  if(khoLabel === 'Kho 3A') return RACK3A_ALL_LOCATORS.slice();
  if(khoLabel === 'Kho 2B') return B2_LOCATORS.slice();
  return [];
}

// Tự động thêm mọi vị trí CÒN THIẾU (so với sơ đồ mặc định) vào các Ô TRỐNG hiện có của grid tuỳ
// chỉnh, theo đúng thứ tự đọc trái->phải/trên->dưới — không đụng tới các ô đã tự sắp xếp sẵn, tự
// thêm hàng mới nếu không đủ chỗ chứa hết.
function khoGridCopyFromDefault(khoLabel){
  const defaultLocs = khoGridDefaultLocatorsFor(khoLabel);
  if(!defaultLocs.length){ alert('Không có danh sách vị trí mặc định cho ' + khoLabel + '.'); return; }
  const layout = khoGridGetLayout(khoLabel);
  const existing = new Set(layout.cells.map(c => String(c.locator || '').trim().toUpperCase()));
  const missing = defaultLocs.filter(loc => !existing.has(String(loc).toUpperCase()));
  if(!missing.length){ alert('Grid tuỳ chỉnh đã có đủ toàn bộ vị trí từ sơ đồ mặc định — không có gì để thêm.'); return; }
  if(!confirm(
    `Thêm ${missing.length} vị trí còn thiếu (theo đúng thứ tự sơ đồ mặc định) vào các ô trống của grid tuỳ chỉnh ${khoLabel}?\n\n` +
    `Các vị trí đã sắp xếp sẵn trong grid được giữ nguyên, không bị đụng tới. Nếu không đủ ô trống, grid sẽ tự thêm hàng mới.`
  )) return;

  const occupied = khoGridBuildOccupied(layout, null);
  let r = 1, c = 1;
  missing.forEach(loc => {
    while(occupied.has(r + ',' + c)){
      c++;
      if(c > layout.cols){ c = 1; r++; }
    }
    if(r > layout.rows) layout.rows = r;
    layout.cells.push({
      id: 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      locator: loc, row: r, col: c, rowSpan: 1, colSpan: 1
    });
    occupied.add(r + ',' + c);
    c++;
    if(c > layout.cols){ c = 1; r++; }
  });
  if(r > layout.rows) layout.rows = r;

  khoGridSave();
  khoGridRenderCustom(khoLabel);
  if(typeof showAppToast === 'function') showAppToast(`✓ Đã thêm ${fmt(missing.length)} vị trí từ sơ đồ mặc định vào grid tuỳ chỉnh ${khoLabel}.`);
}

// CACHE theo tham chiếu currentData — cùng lý do với computeSodo3bByLocator() ở trên (gọi lại mỗi ký
// tự gõ tìm kiếm sơ đồ kho 2B).
let _sodo2bByLocatorCache = null, _sodo2bByLocatorForData = null;
function computeSodo2bByLocator(){
  if(_sodo2bByLocatorForData === currentData && _sodo2bByLocatorCache) return _sodo2bByLocatorCache;
  const map = {};
  B2_LOCATORS.forEach(loc => { map[loc] = []; });
  if(currentData){
    for(const row of getRawRows(currentData)){
      if(row[RAW_KEY_IDX.kho] !== 'Kho 2B') continue;
      const locator = String(row[RAW_KEY_IDX.locator] || '').trim();
      if(!locator) continue;
      (map[locator] || (map[locator] = [])).push(row);
    }
  }
  _sodo2bByLocatorCache = map;
  _sodo2bByLocatorForData = currentData;
  return map;
}

function khoGridGetLayout(khoLabel){
  const cfg = KHO_CUSTOM_GRID_CONFIG[khoLabel] || KHO_CUSTOM_GRID_CONFIG['Kho 3B'];
  if(!khoGridLayouts[khoLabel]) khoGridLayouts[khoLabel] = { rows:cfg.defaultRows, cols:cfg.defaultCols, cells:[] };
  const layout = khoGridLayouts[khoLabel];
  layout.rows = Math.max(1, Number(layout.rows) || cfg.defaultRows);
  layout.cols = Math.max(1, Number(layout.cols) || cfg.defaultCols);
  layout.cells = Array.isArray(layout.cells) ? layout.cells : [];
  return layout;
}
function khoGridSave(){
  _localKhoGridDirty = true;
  saveStateToStorage();
  scheduleAutoSaveToCloud('khogrid', [STORAGE_KEY_KHO_GRID], 'Sửa lưới sơ đồ kho tuỳ chỉnh');
}
function khoGridBuildOccupied(layout, excludeId){
  const occupied = new Set();
  layout.cells.forEach(cell => {
    if(cell.id === excludeId) return;
    for(let r=cell.row;r<cell.row+cell.rowSpan;r++) for(let c=cell.col;c<cell.col+cell.colSpan;c++) occupied.add(r+','+c);
  });
  return occupied;
}
function khoGridRectOverlaps(occupied,row,col,rowSpan,colSpan){
  for(let r=row;r<row+rowSpan;r++) for(let c=col;c<col+colSpan;c++) if(occupied.has(r+','+c)) return true;
  return false;
}
function khoGridBaseCapacity(khoLabel, loc){
  if(khoLabel === 'Kho 3B') return WH3B_MAX_PALLET;
  if(khoLabel === 'Kho 3A') return RACK3A_MAX_PALLET;
  return B2_CAPACITY_MAP[loc] || 24;
}
function khoGridConfigFor(khoLabel){ return KHO_CUSTOM_GRID_CONFIG[khoLabel] || KHO_CUSTOM_GRID_CONFIG['Kho 3B']; }
function khoGridIsCustomMode(khoLabel){ return khoLabel === 'Kho 3B' ? sodo3bGridMode : !!khoCustomGridMode[khoLabel]; }

function khoGridRenderCustom(khoLabel){
  const cfg = khoGridConfigFor(khoLabel);
  const container = document.getElementById(cfg.customGrid);
  if(!container) return;
  const layout = khoGridGetLayout(khoLabel);
  container.className = 'wh3b-custom-grid wh3b-grid';
  container.dataset.kho = khoLabel;
  container.style.gridTemplateColumns = `repeat(${layout.cols}, minmax(72px, 1fr))`;
  container.style.gridTemplateRows = `repeat(${layout.rows}, minmax(90px, auto))`;

  const map = cfg.compute();
  const occupied = khoGridBuildOccupied(layout, null);
  const selKho = _khoGridSelectionKho === khoLabel ? _khoGridSelection : null;
  const htmlParts = [];
  layout.cells.forEach(cell => {
    const isSelectedCell = selKho && selKho.has(khoGridSelectionKey(cell.row, cell.col));
    if(cell.isLabel){
      // Ô tiêu đề tự đặt tên — KHÔNG gán vị trí tồn kho thật, chỉ để ghi chú/chia khu trên sơ đồ. Xây
      // thẳng HTML cuối cùng (không qua buildLocatorBoxHtml/replace như ô locator bên dưới, vì không
      // có số liệu tồn kho/heatmap/nút chỉnh sức chứa để hiển thị).
      htmlParts.push(`
      <div draggable="false" data-kho-grid-drag="1" data-cell-id="${escAttr(cell.id)}" data-cell-row="${cell.row}" data-cell-col="${cell.col}" style="grid-row:${cell.row} / span ${cell.rowSpan}; grid-column:${cell.col} / span ${cell.colSpan};" class="wh3b-box wh3b-box-label${isSelectedCell ? ' wh3b-cell-selected' : ''}">
        <button type="button" class="wh3b-custom-gear" data-cell-id="${escAttr(cell.id)}" style="right:7px;" title="Sửa ô tiêu đề / kích thước / xoá ô này khỏi lưới">
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 3l5 5-13 13H3v-5Z"/><path d="M14 5l5 5"/></svg>
        </button>
        <div class="wh3b-box-label-text">${escHtml(cell.label || '')}</div>
        <div class="wh3b-resize-handle wh3b-resize-e" data-cell-id="${escAttr(cell.id)}" data-dir="e" title="Kéo để đổi độ rộng"></div>
        <div class="wh3b-resize-handle wh3b-resize-s" data-cell-id="${escAttr(cell.id)}" data-dir="s" title="Kéo để đổi độ cao"></div>
        <div class="wh3b-resize-handle wh3b-resize-se" data-cell-id="${escAttr(cell.id)}" data-dir="se" title="Kéo để đổi cả độ rộng lẫn độ cao"></div>
        <span class="wh3b-resize-hint">${cell.colSpan}×${cell.rowSpan}</span>
      </div>`);
      return;
    }
    const rows = map[cell.locator] || [];
    const b = buildLocatorBoxHtml(cell.locator, rows, khoGridBaseCapacity(khoLabel, cell.locator), '');
    const isSelected = isSelectedCell;
    // b.html có thể đã có sẵn 1 thuộc tính style="background:...;" riêng do chế độ Heatmap đang bật
    // (xem khoHeatmapCellStyle()) — PHẢI gộp vào chung với style vị trí/kích thước ô ngay dưới đây
    // thành ĐÚNG 1 thuộc tính style. Nếu để nguyên 2 thuộc tính style trùng tên trên cùng 1 thẻ <div>,
    // trình duyệt chỉ áp dụng thuộc tính ĐẦU TIÊN và âm thầm bỏ qua thuộc tính còn lại (ở đây sẽ mất
    // hẳn màu Heatmap trên grid tuỳ chỉnh, không có lỗi console nào báo).
    const heatStyleMatch = b.html.match(/\sstyle="(background:[^"]*)"/);
    const heatStyle = heatStyleMatch ? heatStyleMatch[1] : '';
    const htmlNoHeatStyle = heatStyleMatch ? b.html.replace(heatStyleMatch[0], '') : b.html;
    const cellHtml = htmlNoHeatStyle.replace(
      '<div class="wh3b-box',
      `<div draggable="false" data-kho-grid-drag="1" data-cell-id="${escAttr(cell.id)}" data-cell-row="${cell.row}" data-cell-col="${cell.col}" style="grid-row:${cell.row} / span ${cell.rowSpan}; grid-column:${cell.col} / span ${cell.colSpan};${heatStyle}" class="wh3b-box${isSelected ? ' wh3b-cell-selected' : ''}`
    ).replace(
      '<button type="button" class="wh3b-box-gear"',
      `<button type="button" class="wh3b-custom-gear" data-cell-id="${escAttr(cell.id)}" title="Sửa vị trí / kích thước / xoá ô này khỏi lưới">
        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 3l5 5-13 13H3v-5Z"/><path d="M14 5l5 5"/></svg>
      </button><button type="button" class="wh3b-box-gear"`
    ).replace(/<\/div>$/, `
      <div class="wh3b-resize-handle wh3b-resize-e" data-cell-id="${escAttr(cell.id)}" data-dir="e" title="Kéo để đổi độ rộng"></div>
      <div class="wh3b-resize-handle wh3b-resize-s" data-cell-id="${escAttr(cell.id)}" data-dir="s" title="Kéo để đổi độ cao"></div>
      <div class="wh3b-resize-handle wh3b-resize-se" data-cell-id="${escAttr(cell.id)}" data-dir="se" title="Kéo để đổi cả độ rộng lẫn độ cao"></div>
      <span class="wh3b-resize-hint">${cell.colSpan}×${cell.rowSpan}</span>
    </div>`);
    htmlParts.push(cellHtml);
  });
  for(let r=1;r<=layout.rows;r++) for(let c=1;c<=layout.cols;c++){
    if(occupied.has(r+','+c)) continue;
    const isSelected = selKho && selKho.has(khoGridSelectionKey(r, c));
    htmlParts.push(`<button type="button" class="wh3b-custom-add-cell${isSelected ? ' wh3b-cell-selected' : ''}" style="grid-row:${r};grid-column:${c};" data-kho="${escAttr(khoLabel)}" data-row="${r}" data-col="${c}" title="Thêm vị trí vào ô hàng ${r}, cột ${c} — giữ Ctrl để chọn làm đích dán">+</button>`);
  }
  container.innerHTML = htmlParts.length ? htmlParts.join('') : `<div class="wh3b-empty">Lưới trống — bấm "+" để bắt đầu thêm vị trí.</div>`;
  whApplySearchFilter(cfg.customGrid, cfg.compute, cfg.search, cfg.pass, cfg.ng, cfg.detail);
}

function khoGridSetMode(khoLabel, enabled){
  const cfg = khoGridConfigFor(khoLabel);
  if(khoLabel === 'Kho 3B') sodo3bGridMode = !!enabled;
  else khoCustomGridMode[khoLabel] = !!enabled;
  const mode = !!enabled;
  const modeBtn = document.getElementById(cfg.modeBtn);
  const defaultGrid = document.getElementById(cfg.defaultGrid);
  const customGrid = document.getElementById(cfg.customGrid);
  const note = document.getElementById(cfg.note);
  const settings = document.getElementById(cfg.settingsBtn);
  const copyBtn = document.getElementById(cfg.copyBtn);
  const hint = cfg.hint ? document.getElementById(cfg.hint) : null;
  if(modeBtn) modeBtn.textContent = mode ? '📋 Sơ đồ mặc định' : '🔲 Grid tuỳ chỉnh';
  if(defaultGrid) defaultGrid.style.display = mode ? 'none' : '';
  if(customGrid) customGrid.style.display = mode ? 'grid' : 'none';
  if(note) note.style.display = mode ? '' : 'none';
  if(settings) settings.style.display = mode ? '' : 'none';
  if(copyBtn) copyBtn.style.display = mode ? '' : 'none';
  if(hint) hint.style.display = mode ? '' : 'none';
  if(mode) khoGridRenderCustom(khoLabel);
  else whApplySearchFilter(cfg.defaultGrid, cfg.compute, cfg.search, cfg.pass, cfg.ng, cfg.detail);
}

// Ô "tiêu đề" (isLabel=true) dùng CHUNG modal thêm/sửa vị trí với ô locator thường — chỉ khác nội
// dung ô nhập (tên tự đặt thay vì mã locator thật) và bỏ qua bước tính tồn kho khi lưu. Toggle 2 nút
// ở đầu modal chuyển qua lại giữa 2 loại, đồng bộ nhãn/placeholder ô nhập cho đúng ngữ cảnh.
let _khoGridCellIsLabel = false;
function khoGridSetCellTypeUI(isLabel){
  _khoGridCellIsLabel = isLabel;
  const locBtn = document.getElementById('kho-grid-cell-type-locator');
  const labelBtn = document.getElementById('kho-grid-cell-type-label');
  if(locBtn) locBtn.classList.toggle('active', !isLabel);
  if(labelBtn) labelBtn.classList.toggle('active', isLabel);
  const hint = document.getElementById('kho-grid-cell-locator-hint');
  const input = document.getElementById('kho-grid-cell-locator');
  if(hint) hint.textContent = isLabel
    ? 'Nội dung ô tiêu đề (tự đặt tên, KHÔNG cần khớp dữ liệu tồn kho)'
    : 'Mã Locator (phải gõ ĐÚNG tên có trong dữ liệu tồn kho/WMS)';
  if(input) input.placeholder = isLabel
    ? 'VD: KHU RACK A'
    : (_khoGridActiveKho==='Kho 2B'?'D2B-FG-A01':_khoGridActiveKho==='Kho 3A'?'3A-A1-T1':'D3B-FG-A01');
}
const khoGridCellTypeLocatorBtn=document.getElementById('kho-grid-cell-type-locator');
if(khoGridCellTypeLocatorBtn) khoGridCellTypeLocatorBtn.addEventListener('click',()=>khoGridSetCellTypeUI(false));
const khoGridCellTypeLabelBtn=document.getElementById('kho-grid-cell-type-label');
if(khoGridCellTypeLabelBtn) khoGridCellTypeLabelBtn.addEventListener('click',()=>khoGridSetCellTypeUI(true));

function khoGridOpenCellPopover(cellId, prefillRow, prefillCol, khoLabel){
  _khoGridActiveKho = khoLabel || _khoGridActiveKho || 'Kho 3B';
  _khoGridEditingCellId = cellId || null;
  const layout = khoGridGetLayout(_khoGridActiveKho);
  const cell = cellId ? layout.cells.find(c=>c.id===cellId) : null;
  const title = document.getElementById('kho-grid-cell-title');
  const locator = document.getElementById('kho-grid-cell-locator');
  const row = document.getElementById('kho-grid-cell-row');
  const col = document.getElementById('kho-grid-cell-col');
  const rowSpan = document.getElementById('kho-grid-cell-rowspan');
  const colSpan = document.getElementById('kho-grid-cell-colspan');
  const del = document.getElementById('kho-grid-cell-delete');
  khoGridSetCellTypeUI(cell ? !!cell.isLabel : false);
  if(title) title.textContent = cell
    ? `Sửa ${cell.isLabel ? 'ô tiêu đề' : 'vị trí'} "${cell.isLabel ? cell.label : cell.locator}" — ${_khoGridActiveKho}`
    : `Thêm vào lưới — ${_khoGridActiveKho}`;
  if(locator) locator.value = cell ? (cell.isLabel ? cell.label : cell.locator) : '';
  if(row) row.value = cell ? cell.row : (prefillRow || 1);
  if(col) col.value = cell ? cell.col : (prefillCol || 1);
  if(rowSpan) rowSpan.value = cell ? cell.rowSpan : 1;
  if(colSpan) colSpan.value = cell ? cell.colSpan : 1;
  if(del) del.style.display = cell ? '' : 'none';
  const overlay=document.getElementById('kho-grid-cell-overlay');
  if(overlay) overlay.classList.add('show');
}

function khoGridOpenSettings(khoLabel){
  _khoGridActiveKho = khoLabel;
  const layout=khoGridGetLayout(khoLabel);
  document.getElementById('kho-grid-rows-input').value=layout.rows;
  document.getElementById('kho-grid-cols-input').value=layout.cols;
  const reset=document.getElementById('kho-grid-reset-all');
  if(reset) reset.textContent=`🗑 Xoá toàn bộ lưới tuỳ chỉnh ${khoLabel}`;
  document.getElementById('kho-grid-settings-overlay').classList.add('show');
}

function khoGridPointToCell(container, clientX, clientY, layout){
  const rect=container.getBoundingClientRect();
  const cs=getComputedStyle(container);
  const cols=cs.gridTemplateColumns.trim().split(/\s+/).map(parseFloat).filter(Number.isFinite);
  const rows=cs.gridTemplateRows.trim().split(/\s+/).map(parseFloat).filter(Number.isFinite);
  const gapX=parseFloat(cs.columnGap)||10, gapY=parseFloat(cs.rowGap)||10;
  const avgX=cols.length?cols.reduce((a,b)=>a+b,0)/cols.length:Math.max(72,(rect.width-gapX*(layout.cols-1))/layout.cols);
  const avgY=rows.length?rows.reduce((a,b)=>a+b,0)/rows.length:90;
  const col=Math.min(layout.cols,Math.max(1,Math.floor((clientX-rect.left+gapX/2)/(avgX+gapX))+1));
  const row=Math.min(layout.rows,Math.max(1,Math.floor((clientY-rect.top+gapY/2)/(avgY+gapY))+1));
  return {row,col};
}

function khoGridTryMoveCell(st, clientX, clientY){
  const target=khoGridPointToCell(st.container,clientX,clientY,st.layout);
  let row=Math.min(Math.max(target.row,1),st.layout.rows-st.cell.rowSpan+1);
  let col=Math.min(Math.max(target.col,1),st.layout.cols-st.cell.colSpan+1);
  if(khoGridRectOverlaps(st.occupied,row,col,st.cell.rowSpan,st.cell.colSpan)){
    // Tìm ô gần nhất còn trống theo khoảng cách Manhattan.
    const candidates=[];
    for(let r=1;r<=st.layout.rows-st.cell.rowSpan+1;r++) for(let c=1;c<=st.layout.cols-st.cell.colSpan+1;c++){
      if(khoGridRectOverlaps(st.occupied,r,c,st.cell.rowSpan,st.cell.colSpan)) continue;
      candidates.push({r,c,d:Math.abs(r-row)+Math.abs(c-col)});
    }
    candidates.sort((a,b)=>a.d-b.d);
    if(!candidates.length) return false;
    row=candidates[0].r; col=candidates[0].c;
  }
  st.curRow=row; st.curCol=col;
  st.boxEl.style.gridRow=`${row} / span ${st.cell.rowSpan}`;
  st.boxEl.style.gridColumn=`${col} / span ${st.cell.colSpan}`;
  const hint=st.boxEl.querySelector('.wh3b-resize-hint');
  if(hint) hint.textContent=`${st.cell.colSpan}×${st.cell.rowSpan} · ${row},${col}`;
  return true;
}

// Kéo locator để DI CHUYỂN — chỉ kích hoạt trong grid tuỳ chỉnh và bỏ qua 2 nút bánh răng/resize
// handle. LƯU Ý: KHÔNG được loại trừ ".wh3b-box-main" — dù bản thân nó là 1 thẻ <button> (để bấm
// xem chi tiết pallet), nó lại là vùng hiển thị CHIẾM GẦN HẾT diện tích ô (tên vị trí/SL/thanh %) —
// nếu loại trừ mọi <button> như trước, gần như không còn chỗ nào để bắt đầu kéo được nữa. Việc bấm
// nhẹ (không kéo di chuyển) trên ".wh3b-box-main" vẫn hoạt động bình thường như cũ (xem cờ
// _khoGridSuppressClick — chỉ chặn click SAU KHI đã thực sự kéo di chuyển xong).
document.addEventListener('pointerdown',(e)=>{
  const box=e.target.closest('.wh3b-custom-grid .wh3b-box[data-kho-grid-drag="1"]');
  if(!box || e.target.closest('.wh3b-box-gear,.wh3b-custom-gear,.wh3b-resize-handle')) return;
  const container=box.closest('.wh3b-custom-grid');
  const kho=container?.dataset.kho || _khoGridActiveKho;
  if(!kho || !khoGridIsCustomMode(kho)) return;
  const layout=khoGridGetLayout(kho);
  const cell=layout.cells.find(c=>c.id===box.dataset.cellId || c.locator===box.dataset.locator);
  if(!cell) return;
  // Giữ Ctrl (hoặc Cmd trên Mac) = chọn/bỏ chọn ô này (không kéo di chuyển) — xử lý ngay ở pointerdown
  // để KHÔNG kích hoạt kéo-thả, và chặn luôn sự kiện click phía sau (mở chi tiết pallet) bằng
  // _khoGridSuppressClick, giống hệt cách đang chặn click sau khi kéo-thả xong.
  // LƯU Ý QUAN TRỌNG: render lại lưới (khoGridRenderCustom) phải HOÃN sang tick kế tiếp (setTimeout 0),
  // KHÔNG được gọi ngay trong pointerdown — vì hàm này dựng lại innerHTML, thay hẳn node <button> đang
  // nhận pointerdown bằng 1 node mới. Nếu làm ngay, trình duyệt (Chromium) sẽ KHÔNG bắn sự kiện "click"
  // tiếp theo nữa (vì node gốc đã biến mất khỏi DOM giữa chừng cú bấm) -> cờ _khoGridSuppressClick không
  // bao giờ được set lại về false -> lần bấm KẾ TIẾP bất kỳ đâu trong lưới bị nuốt oan. Hoãn render giúp
  // sự kiện click gốc kịp bắn ra và tự dọn cờ trước khi DOM bị thay.
  if(e.ctrlKey || e.metaKey){
    e.preventDefault(); e.stopPropagation();
    khoGridToggleSelect(kho, cell.row, cell.col);
    _khoGridSuppressClick = true;
    setTimeout(()=>khoGridRenderCustom(kho), 0);
    return;
  }
  e.preventDefault(); e.stopPropagation();

  // Nếu ô đang nắm để kéo NẰM TRONG vùng đang chọn (từ 2 ô trở lên) -> kéo CẢ NHÓM cùng lúc, giữ
  // nguyên vị trí tương đối giữa các ô trong nhóm. Ngược lại (kéo 1 ô không thuộc vùng chọn, hoặc
  // chưa chọn gì) -> chỉ kéo riêng ô đó, y như hành vi cũ.
  const selKho = _khoGridSelectionKho === kho ? _khoGridSelection : null;
  const isAnchorSelected = selKho && selKho.has(khoGridSelectionKey(cell.row, cell.col));
  let group = null;
  if(isAnchorSelected && selKho.size > 1){
    group = [];
    selKho.forEach(posKey => {
      const [r,c] = posKey.split(',').map(Number);
      const gc = layout.cells.find(cc => cc.row===r && cc.col===c);
      if(!gc) return;
      const gBox = container.querySelector(`.wh3b-box[data-cell-id="${CSS.escape(gc.id)}"]`);
      if(!gBox) return;
      group.push({cell:gc, boxEl:gBox});
    });
    if(group.length <= 1) group = null; // phòng hờ: không tìm đủ ô -> coi như kéo đơn lẻ
  }

  if(group){
    let occupied = khoGridBuildOccupied(layout, null);
    group.forEach(g => {
      for(let r=g.cell.row;r<g.cell.row+g.cell.rowSpan;r++) for(let c=g.cell.col;c<g.cell.col+g.cell.colSpan;c++) occupied.delete(r+','+c);
    });
    _khoGridDragState={kho,layout,container,group,occupied,anchorOrigRow:cell.row,anchorOrigCol:cell.col,curDRow:0,curDCol:0,startX:e.clientX,startY:e.clientY,moved:false,pointerId:e.pointerId};
  } else {
    _khoGridDragState={kho,layout,cell,boxEl:box,container,occupied:khoGridBuildOccupied(layout,cell.id),startX:e.clientX,startY:e.clientY,curRow:cell.row,curCol:cell.col,moved:false,pointerId:e.pointerId};
  }
  try{box.setPointerCapture(e.pointerId);}catch(err){}
});
document.addEventListener('pointermove',(e)=>{
  const st=_khoGridDragState; if(!st) return;
  const dx=e.clientX-st.startX,dy=e.clientY-st.startY;
  if(!st.moved && Math.hypot(dx,dy)<6) return;
  st.moved=true;
  if(st.group){
    st.group.forEach(g=>g.boxEl.classList.add('wh3b-dragging'));
    khoGridTryMoveGroup(st,e.clientX,e.clientY);
  } else {
    st.boxEl.classList.add('wh3b-dragging');
    khoGridTryMoveCell(st,e.clientX,e.clientY);
  }
});
// Tương tự khoGridTryMoveCell() nhưng di chuyển CẢ NHÓM ô cùng lúc, giữ nguyên khoảng cách tương đối
// giữa chúng — không "snap" từng ô về ô trống gần nhất riêng lẻ (dễ làm vỡ đội hình đang chọn), chỉ
// chấp nhận vị trí mới khi TOÀN BỘ nhóm cùng hợp lệ (trong biên lưới, không đè lên ô ngoài nhóm).
function khoGridTryMoveGroup(st, clientX, clientY){
  const target=khoGridPointToCell(st.container,clientX,clientY,st.layout);
  let dRow=target.row-st.anchorOrigRow, dCol=target.col-st.anchorOrigCol;
  st.group.forEach(g => {
    const minDRow=1-g.cell.row, maxDRow=st.layout.rows-g.cell.rowSpan+1-g.cell.row;
    const minDCol=1-g.cell.col, maxDCol=st.layout.cols-g.cell.colSpan+1-g.cell.col;
    dRow=Math.min(Math.max(dRow,minDRow),maxDRow);
    dCol=Math.min(Math.max(dCol,minDCol),maxDCol);
  });
  const allOk=st.group.every(g => !khoGridRectOverlaps(st.occupied,g.cell.row+dRow,g.cell.col+dCol,g.cell.rowSpan,g.cell.colSpan));
  if(!allOk) return false;
  st.curDRow=dRow; st.curDCol=dCol;
  st.group.forEach(g => {
    g.boxEl.style.gridRow=`${g.cell.row+dRow} / span ${g.cell.rowSpan}`;
    g.boxEl.style.gridColumn=`${g.cell.col+dCol} / span ${g.cell.colSpan}`;
  });
  return true;
}
function khoGridEndDrag(){
  const st=_khoGridDragState; if(!st) return;
  _khoGridDragState=null;
  if(st.group){
    st.group.forEach(g=>g.boxEl.classList.remove('wh3b-dragging'));
    if(st.moved) _khoGridSuppressClick = true;
    if(st.moved && (st.curDRow || st.curDCol)){
      st.group.forEach(g => { g.cell.row+=st.curDRow; g.cell.col+=st.curDCol; });
      // Cập nhật lại vùng chọn theo vị trí MỚI — giữ nguyên đang chọn đúng các ô đó sau khi thả.
      if(_khoGridSelectionKho===st.kho) _khoGridSelection=new Set(st.group.map(g=>khoGridSelectionKey(g.cell.row,g.cell.col)));
      khoGridSave(); khoGridRenderCustom(st.kho);
    }
    return;
  }
  st.boxEl.classList.remove('wh3b-dragging');
  if(st.moved) _khoGridSuppressClick = true;
  if(st.moved && (st.curRow!==st.cell.row || st.curCol!==st.cell.col)){
    st.cell.row=st.curRow; st.cell.col=st.curCol; khoGridSave(); khoGridRenderCustom(st.kho);
  }
}
document.addEventListener('pointerup',khoGridEndDrag);
document.addEventListener('pointercancel',khoGridEndDrag);

// Kéo resize — giữ nguyên hành vi cũ, nhưng dùng kho đang active.
document.addEventListener('pointerdown',(e)=>{
  const handle=e.target.closest('.wh3b-custom-grid .wh3b-resize-handle');
  if(!handle) return;
  const container=handle.closest('.wh3b-custom-grid');
  const kho=container?.dataset.kho || _khoGridActiveKho;
  const layout=khoGridGetLayout(kho);
  const cell=layout.cells.find(c=>c.id===handle.dataset.cellId);
  const boxEl=handle.closest('.wh3b-box'); if(!cell||!container||!boxEl) return;
  e.preventDefault();e.stopPropagation();
  const cs=getComputedStyle(container);
  const cols=cs.gridTemplateColumns.trim().split(/\s+/).map(parseFloat).filter(Number.isFinite);
  const rows=cs.gridTemplateRows.trim().split(/\s+/).map(parseFloat).filter(Number.isFinite);
  const gapX=parseFloat(cs.columnGap)||10,gapY=parseFloat(cs.rowGap)||10;
  const stepX=(cols.reduce((a,b)=>a+b,0)/(cols.length||1))+gapX;
  const stepY=(rows.reduce((a,b)=>a+b,0)/(rows.length||1))+gapY;
  _khoGridResizeState={cell,boxEl,layout,dir:handle.dataset.dir,stepX,stepY,occupied:khoGridBuildOccupied(layout,cell.id),startX:e.clientX,startY:e.clientY,origColSpan:cell.colSpan,origRowSpan:cell.rowSpan,curColSpan:cell.colSpan,curRowSpan:cell.rowSpan,kho};
  boxEl.classList.add('wh3b-resizing'); try{handle.setPointerCapture(e.pointerId);}catch(err){}
});
document.addEventListener('pointermove',(e)=>{
  const st=_khoGridResizeState; if(!st) return;
  const dx=e.clientX-st.startX,dy=e.clientY-st.startY;
  let colSpan=st.origColSpan,rowSpan=st.origRowSpan;
  if(st.dir==='e'||st.dir==='se') colSpan=st.origColSpan+Math.round(dx/st.stepX);
  if(st.dir==='s'||st.dir==='se') rowSpan=st.origRowSpan+Math.round(dy/st.stepY);
  colSpan=Math.min(Math.max(colSpan,1),st.layout.cols-st.cell.col+1);
  rowSpan=Math.min(Math.max(rowSpan,1),st.layout.rows-st.cell.row+1);
  while(colSpan>1&&khoGridRectOverlaps(st.occupied,st.cell.row,st.cell.col,rowSpan,colSpan)) colSpan--;
  while(rowSpan>1&&khoGridRectOverlaps(st.occupied,st.cell.row,st.cell.col,rowSpan,colSpan)) rowSpan--;
  st.curColSpan=colSpan;st.curRowSpan=rowSpan;
  st.boxEl.style.gridColumn=`${st.cell.col} / span ${colSpan}`;st.boxEl.style.gridRow=`${st.cell.row} / span ${rowSpan}`;
  const hint=st.boxEl.querySelector('.wh3b-resize-hint');if(hint)hint.textContent=`${colSpan}×${rowSpan}`;
});
function khoGridEndResize(){
  const st=_khoGridResizeState;if(!st)return;_khoGridResizeState=null;st.boxEl.classList.remove('wh3b-resizing');
  if(st.curColSpan!==st.origColSpan||st.curRowSpan!==st.origRowSpan){st.cell.colSpan=st.curColSpan;st.cell.rowSpan=st.curRowSpan;khoGridSave();}
  khoGridRenderCustom(st.kho);
}
document.addEventListener('pointerup',khoGridEndResize);document.addEventListener('pointercancel',khoGridEndResize);

// Kéo chuột vẽ vùng chọn hình chữ nhật (marquee) — bắt đầu khi bấm vào NỀN TRỐNG của lưới hoặc vào
// đúng 1 ô "+" (KHÔNG bắt đầu khi bấm vào ô đã có locator/gear/resize-handle — những chỗ đó đã có
// hành vi kéo-thả/resize riêng, xem 2 khối pointerdown phía trên). Giữ Ctrl khi kéo = CỘNG THÊM vào
// vùng đang chọn thay vì thay thế hẳn.
document.addEventListener('pointerdown',(e)=>{
  const container=e.target.closest('.wh3b-custom-grid');
  if(!container || e.target.closest('.wh3b-box,.wh3b-custom-gear,.wh3b-resize-handle')) return;
  const kho=container.dataset.kho || _khoGridActiveKho;
  if(!kho || !khoGridIsCustomMode(kho)) return;
  // CHƯA gọi preventDefault()/setPointerCapture() ở đây — chỉ mới là pointerdown, có thể chỉ là 1 cú
  // bấm bình thường (VD: bấm nút "+" để thêm vị trí, có Ctrl hay không). Chỉ thật sự "vào chế độ kéo
  // chọn vùng" (và mới preventDefault/capture) khi đã xác nhận CÓ kéo (xem pointermove bên dưới) —
  // làm sớm quá sẽ vô tình chặn mất sự kiện "click" bình thường theo sau của nút "+".
  _khoGridMarquee={kho,container,startX:e.clientX,startY:e.clientY,moved:false,additive:e.ctrlKey||e.metaKey,pointerId:e.pointerId,el:null,curRect:null};
});
document.addEventListener('pointermove',(e)=>{
  const st=_khoGridMarquee; if(!st) return;
  const dx=e.clientX-st.startX,dy=e.clientY-st.startY;
  if(!st.moved && Math.hypot(dx,dy)<6) return;
  if(!st.moved){
    st.moved=true;
    e.preventDefault();
    try{st.container.setPointerCapture(st.pointerId);}catch(err){}
    st.el=document.createElement('div'); st.el.className='wh3b-marquee'; document.body.appendChild(st.el);
  }
  const x1=Math.min(st.startX,e.clientX), x2=Math.max(st.startX,e.clientX);
  const y1=Math.min(st.startY,e.clientY), y2=Math.max(st.startY,e.clientY);
  st.el.style.left=x1+'px'; st.el.style.top=y1+'px'; st.el.style.width=(x2-x1)+'px'; st.el.style.height=(y2-y1)+'px';
  st.curRect={x1,y1,x2,y2};
});
function khoGridEndMarquee(){
  const st=_khoGridMarquee; if(!st) return;
  _khoGridMarquee=null;
  if(st.el) st.el.remove();
  if(!st.moved) return; // chỉ là 1 cú bấm bình thường (không kéo) — để nguyên cho handler click xử lý tiếp
  _khoGridSuppressClick=true;
  const newSel=new Set();
  st.container.querySelectorAll('.wh3b-box[data-kho-grid-drag="1"], .wh3b-custom-add-cell').forEach(el=>{
    const r=el.getBoundingClientRect();
    const intersects=r.left<st.curRect.x2 && r.right>st.curRect.x1 && r.top<st.curRect.y2 && r.bottom>st.curRect.y1;
    if(!intersects) return;
    let row,col;
    if(el.classList.contains('wh3b-custom-add-cell')){ row=Number(el.dataset.row); col=Number(el.dataset.col); }
    else{ row=Number(el.dataset.cellRow); col=Number(el.dataset.cellCol); }
    newSel.add(khoGridSelectionKey(row,col));
  });
  if(!newSel.size) return;
  if(st.additive && _khoGridSelectionKho===st.kho) newSel.forEach(k=>_khoGridSelection.add(k));
  else _khoGridSelection=newSel;
  _khoGridSelectionKho=st.kho;
  khoGridRenderCustom(st.kho);
}
document.addEventListener('pointerup',khoGridEndMarquee);
document.addEventListener('pointercancel',khoGridEndMarquee);

// Điều khiển chung cho 3B / 3A / 2B.
document.addEventListener('click',(e)=>{
  for(const [kho,cfg] of Object.entries(KHO_CUSTOM_GRID_CONFIG)){
    const modeBtn=e.target.closest('#'+cfg.modeBtn);
    if(modeBtn){e.stopImmediatePropagation();khoGridSetMode(kho,!khoGridIsCustomMode(kho));return;}
    const settingsBtn=e.target.closest('#'+cfg.settingsBtn);
    if(settingsBtn){e.stopImmediatePropagation();khoGridOpenSettings(kho);return;}
    const copyBtn=e.target.closest('#'+cfg.copyBtn);
    if(copyBtn){e.stopImmediatePropagation();khoGridCopyFromDefault(kho);return;}
    const heatmapBtn=e.target.closest('#'+cfg.heatmapBtn);
    if(heatmapBtn){e.stopImmediatePropagation();khoHeatmapCycle();return;}
  }
  if(_khoGridSuppressClick){ _khoGridSuppressClick=false; e.preventDefault(); e.stopImmediatePropagation(); return; }
  const addBtn=e.target.closest('.wh3b-custom-add-cell');
  if(addBtn){
    e.stopPropagation();
    // Giữ Ctrl = chọn/bỏ chọn ô trống này (làm đích dán), KHÔNG mở popup thêm vị trí.
    if(e.ctrlKey || e.metaKey){
      khoGridToggleSelect(addBtn.dataset.kho, Number(addBtn.dataset.row), Number(addBtn.dataset.col));
      khoGridRenderCustom(addBtn.dataset.kho);
      return;
    }
    khoGridOpenCellPopover(null,Number(addBtn.dataset.row),Number(addBtn.dataset.col),addBtn.dataset.kho);return;
  }
  const gearBtn=e.target.closest('.wh3b-custom-gear');
  if(gearBtn){e.stopImmediatePropagation();const box=gearBtn.closest('.wh3b-box');const kho=box?.closest('.wh3b-custom-grid')?.dataset.kho || _khoGridActiveKho;khoGridOpenCellPopover(gearBtn.dataset.cellId,null,null,kho);return;}
});

// Escape = bỏ chọn; Ctrl/Cmd+C = sao chép; Ctrl/Cmd+X = cắt; Ctrl/Cmd+V = dán — CHỈ tác động khi đang
// thật sự có vùng chọn/clipboard của grid tuỳ chỉnh (nếu không, để nguyên hành vi copy/paste bình
// thường của trình duyệt ở mọi nơi khác trong app — xem điều kiện bảo vệ bên dưới).
document.addEventListener('keydown',(e)=>{
  const ae=document.activeElement;
  const isEditable=ae && (ae.tagName==='INPUT' || ae.tagName==='TEXTAREA' || ae.isContentEditable);

  if(e.key==='Escape' && !isEditable && _khoGridSelection.size){
    const kho=_khoGridSelectionKho;
    khoGridClearSelection();
    if(kho) khoGridRenderCustom(kho);
    return;
  }
  // Delete/Backspace = xoá thẳng toàn bộ ô đang chọn (nhiều ô cùng lúc) khỏi lưới tuỳ chỉnh — không
  // cần Ctrl, chỉ cần đang có vùng chọn (giống hành vi xoá ô đơn lẻ ở popover ⚙️, nhưng làm hàng loạt).
  if((e.key==='Delete' || e.key==='Backspace') && !isEditable && _khoGridSelectionKho && _khoGridSelection.size){
    const kho=_khoGridSelectionKho;
    const layout=khoGridGetLayout(kho);
    const ids=[];
    _khoGridSelection.forEach(posKey=>{
      const [r,c]=posKey.split(',').map(Number);
      const cell=layout.cells.find(cc=>cc.row===r && cc.col===c);
      if(cell) ids.push(cell.id);
    });
    if(!ids.length){
      if(typeof showAppToast==='function') showAppToast('⚠ Vùng đang chọn không có ô nào đã đặt locator để xoá.');
      return;
    }
    e.preventDefault();
    if(!confirm(`Xoá ${ids.length} vị trí đã chọn khỏi lưới ${kho}? (không ảnh hưởng dữ liệu tồn kho thật)`)) return;
    layout.cells=layout.cells.filter(cc=>!ids.includes(cc.id));
    khoGridClearSelection();
    khoGridSave();
    khoGridRenderCustom(kho);
    if(typeof showAppToast==='function') showAppToast(`🗑 Đã xoá ${ids.length} vị trí khỏi lưới ${kho}.`);
    return;
  }
  if(isEditable) return;
  if(!(e.ctrlKey || e.metaKey)) return;
  const key=e.key.toLowerCase();
  if(key!=='c' && key!=='x' && key!=='v') return;

  if(key==='c' || key==='x'){
    if(!_khoGridSelectionKho || !_khoGridSelection.size) return;
    const kho=_khoGridSelectionKho;
    const layout=khoGridGetLayout(kho);
    const anchor=khoGridSelectionAnchor();
    const found=[];
    _khoGridSelection.forEach(posKey=>{
      const [r,c]=posKey.split(',').map(Number);
      const cell=layout.cells.find(cc=>cc.row===r && cc.col===c);
      if(cell) found.push(cell);
    });
    if(!found.length){
      if(typeof showAppToast==='function') showAppToast('⚠ Vùng đang chọn không có ô nào đã đặt locator để sao chép/cắt.');
      return;
    }
    e.preventDefault();
    _khoGridClipboard={
      kho, cut:key==='x',
      cutIds: key==='x' ? found.map(c=>c.id) : null,
      cells: found.map(c=>({isLabel:c.isLabel, locator:c.locator, label:c.label, rowSpan:c.rowSpan, colSpan:c.colSpan, rowOffset:c.row-anchor.row, colOffset:c.col-anchor.col}))
    };
    // Bỏ chọn NGAY sau khi Copy/Cắt — nếu để nguyên vùng đang chọn (vẫn là chính các ô vừa Copy), lỡ
    // người dùng Ctrl+Click CỘNG THÊM 1 ô đích mới mà quên bỏ chọn các ô cũ trước, góc neo (điểm nhỏ
    // nhất) vẫn rơi vào đúng các ô cũ đó -> dán đè lên chính chỗ cũ -> luôn báo xung đột 100%, y hệt
    // lỗi thật đã gặp. Bắt buộc chọn LẠI từ đầu cho ô đích giúp tránh hẳn lỗi này.
    khoGridClearSelection();
    khoGridRenderCustom(kho);
    if(typeof showAppToast==='function') showAppToast(`${key==='x'?'✂ Đã cắt':'📋 Đã sao chép'} ${found.length} ô từ ${kho} — Ctrl+Click (hoặc kéo chuột) chọn MỚI 1 ô đích rồi Ctrl+V để dán.`);
    return;
  }

  // Dán (Ctrl+V) — vị trí đích = góc trên-trái của vùng ĐANG CHỌN lúc bấm dán (Ctrl+Click 1 ô đích,
  // hoặc kéo chuột chọn vùng đích, trước khi dán).
  if(!_khoGridClipboard) return;
  e.preventDefault();
  const anchor=khoGridSelectionAnchor();
  if(!anchor){
    if(typeof showAppToast==='function') showAppToast('⚠ Hãy Ctrl+Click (hoặc kéo chuột) chọn 1 ô đích trước khi dán.');
    return;
  }
  const kho=_khoGridSelectionKho;
  const layout=khoGridGetLayout(kho);
  let occupied=khoGridBuildOccupied(layout,null);
  // Đang CẮT và dán lại vào ĐÚNG kho đã cắt -> bỏ các ô nguồn ra khỏi danh sách "đã chiếm chỗ" trước
  // khi kiểm tra, để cho phép dán đè lên đúng khu vực cũ (di chuyển tại chỗ vẫn hợp lệ).
  if(_khoGridClipboard.cut && _khoGridClipboard.kho===kho && _khoGridClipboard.cutIds){
    _khoGridClipboard.cutIds.forEach(id=>{
      const cell=layout.cells.find(cc=>cc.id===id); if(!cell) return;
      for(let r=cell.row;r<cell.row+cell.rowSpan;r++) for(let c=cell.col;c<cell.col+cell.colSpan;c++) occupied.delete(r+','+c);
    });
  }
  const placements=_khoGridClipboard.cells.map(c=>({...c, row:anchor.row+c.rowOffset, col:anchor.col+c.colOffset}));
  const outOfBounds=placements.filter(p=>p.row<1||p.col<1||p.row+p.rowSpan-1>layout.rows||p.col+p.colSpan-1>layout.cols);
  if(outOfBounds.length){
    alert(`${outOfBounds.length} ô sẽ nằm NGOÀI lưới hiện tại (${layout.rows} hàng × ${layout.cols} cột) — huỷ dán. Hãy mở rộng lưới (⚙️ Cài đặt lưới) hoặc chọn đích khác rồi thử lại.`);
    return;
  }
  const conflicts=placements.filter(p=>khoGridRectOverlaps(occupied,p.row,p.col,p.rowSpan,p.colSpan));
  if(conflicts.length && !confirm(`${conflicts.length}/${placements.length} ô sẽ đè lên ô đã có sẵn trên lưới — bỏ qua đúng ${conflicts.length} ô đó, vẫn dán các ô còn lại?`)) return;
  if(_khoGridClipboard.cut && _khoGridClipboard.cutIds){
    layout.cells=layout.cells.filter(cc=>!_khoGridClipboard.cutIds.includes(cc.id));
  }
  let added=0;
  placements.forEach(p=>{
    if(khoGridRectOverlaps(khoGridBuildOccupied(layout,null),p.row,p.col,p.rowSpan,p.colSpan)) return;
    layout.cells.push({id:'g'+Date.now().toString(36)+Math.random().toString(36).slice(2,6)+added,isLabel:p.isLabel,locator:p.locator,label:p.label,row:p.row,col:p.col,rowSpan:p.rowSpan,colSpan:p.colSpan});
    added++;
  });
  if(!added){ if(typeof showAppToast==='function') showAppToast('⚠ Không dán được ô nào (toàn bộ đều bị xung đột với ô có sẵn).'); return; }
  if(_khoGridClipboard.cut) _khoGridClipboard=null; // cắt chỉ dán được đúng 1 lần
  khoGridSave();
  khoGridRenderCustom(kho);
  if(typeof showAppToast==='function') showAppToast(`✓ Đã dán ${added} ô vào ${kho}.`);
});

// Khi custom grid render, ghi khoLabel vào container để pointer events biết đang thao tác kho nào.
const _oldKghRender = khoGridRenderCustom;
khoGridRenderCustom = function(khoLabel){
  _oldKghRender(khoLabel);
  const cfg=khoGridConfigFor(khoLabel);const el=document.getElementById(cfg.customGrid);if(el)el.dataset.kho=khoLabel;
};

// Modal settings chung.
const khoGridSettingsCloseBtn=document.getElementById('kho-grid-settings-close');
if(khoGridSettingsCloseBtn) khoGridSettingsCloseBtn.addEventListener('click',()=>document.getElementById('kho-grid-settings-overlay').classList.remove('show'));
const khoGridApplySizeBtn=document.getElementById('kho-grid-apply-size');
if(khoGridApplySizeBtn) khoGridApplySizeBtn.addEventListener('click',()=>{
  const kho=_khoGridActiveKho,cfg=khoGridConfigFor(kho),layout=khoGridGetLayout(kho);
  const newRows=Math.min(100,Math.max(1,Math.round(Number(document.getElementById('kho-grid-rows-input').value)||layout.rows)));
  const newCols=Math.min(30,Math.max(1,Math.round(Number(document.getElementById('kho-grid-cols-input').value)||layout.cols)));
  const out=layout.cells.filter(c=>(c.row+c.rowSpan-1)>newRows||(c.col+c.colSpan-1)>newCols);
  if(out.length){if(!confirm(`Kích thước mới sẽ làm ${out.length} ô (${out.map(c=>c.isLabel?c.label:c.locator).join(', ')}) nằm NGOÀI lưới và bị xoá khỏi lưới. Vẫn áp dụng?`))return;layout.cells=layout.cells.filter(c=>!out.includes(c));}
  layout.rows=newRows;layout.cols=newCols;khoGridSave();khoGridRenderCustom(kho);document.getElementById('kho-grid-settings-overlay').classList.remove('show');
});

// Mở rộng/thu nhỏ lưới từ hàng TRÊN CÙNG / cột TRÁI CÙNG — khác với "Áp dụng kích thước" ở trên (chỉ
// thêm/bớt được ở hàng CUỐI/cột CUỐI, vì hàng/cột luôn đánh số từ 1), 4 nút này thêm/bớt đúng ở ĐẦU
// lưới: khi thêm, mọi ô đã đặt tự dịch xuống/dịch phải 1 đơn vị (row++/col++) để giữ đúng hình dạng
// tương đối; khi bớt, dịch ngược lại — nếu hàng/cột đó đang có ô, hỏi xác nhận trước khi xoá.
function khoGridExpandTop(){
  const kho=_khoGridActiveKho, layout=khoGridGetLayout(kho);
  if(layout.rows>=100){ alert('Lưới đã đạt tối đa 100 hàng.'); return; }
  layout.rows++; layout.cells.forEach(c=>c.row++);
  khoGridSave(); khoGridRenderCustom(kho);
  const rowsInput=document.getElementById('kho-grid-rows-input'); if(rowsInput) rowsInput.value=layout.rows;
}
function khoGridShrinkTop(){
  const kho=_khoGridActiveKho, layout=khoGridGetLayout(kho);
  if(layout.rows<=1) return;
  const inTop=layout.cells.filter(c=>c.row===1);
  if(inTop.length && !confirm(`Hàng trên cùng đang có ${inTop.length} ô (${inTop.map(c=>c.isLabel?c.label:c.locator).join(', ')}) — bớt hàng này sẽ XOÁ các ô đó khỏi lưới. Vẫn tiếp tục?`)) return;
  layout.cells=layout.cells.filter(c=>c.row!==1);
  layout.cells.forEach(c=>c.row--);
  layout.rows--;
  khoGridSave(); khoGridRenderCustom(kho);
  const rowsInput=document.getElementById('kho-grid-rows-input'); if(rowsInput) rowsInput.value=layout.rows;
}
function khoGridExpandLeft(){
  const kho=_khoGridActiveKho, layout=khoGridGetLayout(kho);
  if(layout.cols>=30){ alert('Lưới đã đạt tối đa 30 cột.'); return; }
  layout.cols++; layout.cells.forEach(c=>c.col++);
  khoGridSave(); khoGridRenderCustom(kho);
  const colsInput=document.getElementById('kho-grid-cols-input'); if(colsInput) colsInput.value=layout.cols;
}
function khoGridShrinkLeft(){
  const kho=_khoGridActiveKho, layout=khoGridGetLayout(kho);
  if(layout.cols<=1) return;
  const inLeft=layout.cells.filter(c=>c.col===1);
  if(inLeft.length && !confirm(`Cột trái cùng đang có ${inLeft.length} ô (${inLeft.map(c=>c.isLabel?c.label:c.locator).join(', ')}) — bớt cột này sẽ XOÁ các ô đó khỏi lưới. Vẫn tiếp tục?`)) return;
  layout.cells=layout.cells.filter(c=>c.col!==1);
  layout.cells.forEach(c=>c.col--);
  layout.cols--;
  khoGridSave(); khoGridRenderCustom(kho);
  const colsInput=document.getElementById('kho-grid-cols-input'); if(colsInput) colsInput.value=layout.cols;
}
const khoGridExpandTopBtn=document.getElementById('kho-grid-expand-top');
if(khoGridExpandTopBtn) khoGridExpandTopBtn.addEventListener('click', khoGridExpandTop);
const khoGridShrinkTopBtn=document.getElementById('kho-grid-shrink-top');
if(khoGridShrinkTopBtn) khoGridShrinkTopBtn.addEventListener('click', khoGridShrinkTop);
const khoGridExpandLeftBtn=document.getElementById('kho-grid-expand-left');
if(khoGridExpandLeftBtn) khoGridExpandLeftBtn.addEventListener('click', khoGridExpandLeft);
const khoGridShrinkLeftBtn=document.getElementById('kho-grid-shrink-left');
if(khoGridShrinkLeftBtn) khoGridShrinkLeftBtn.addEventListener('click', khoGridShrinkLeft);

const khoGridResetAllBtn=document.getElementById('kho-grid-reset-all');
if(khoGridResetAllBtn) khoGridResetAllBtn.addEventListener('click',()=>{
  const kho=_khoGridActiveKho;
  if(!confirm(`Xoá TOÀN BỘ lưới tuỳ chỉnh của ${kho} (mọi vị trí đã đặt)? Không ảnh hưởng tới dữ liệu tồn kho thật.`))return;
  const cfg=khoGridConfigFor(kho);khoGridLayouts[kho]={rows:cfg.defaultRows,cols:cfg.defaultCols,cells:[]};khoGridSave();khoGridRenderCustom(kho);document.getElementById('kho-grid-settings-overlay').classList.remove('show');
});
const khoGridCellCloseBtn=document.getElementById('kho-grid-cell-close');
if(khoGridCellCloseBtn) khoGridCellCloseBtn.addEventListener('click',()=>document.getElementById('kho-grid-cell-overlay').classList.remove('show'));
const khoGridCellSaveBtn=document.getElementById('kho-grid-cell-save');
if(khoGridCellSaveBtn) khoGridCellSaveBtn.addEventListener('click',()=>{
  const kho=_khoGridActiveKho,layout=khoGridGetLayout(kho);
  const isLabel=_khoGridCellIsLabel;
  const rawValue=document.getElementById('kho-grid-cell-locator').value.trim();
  const locator=isLabel?'':rawValue.toUpperCase(); // Locator luôn IN HOA cho khớp dữ liệu; ô tiêu đề giữ nguyên chữ hoa/thường người dùng gõ.
  const label=isLabel?rawValue:'';
  const row=Math.round(Number(document.getElementById('kho-grid-cell-row').value));
  const col=Math.round(Number(document.getElementById('kho-grid-cell-col').value));
  const rowSpan=Math.max(1,Math.round(Number(document.getElementById('kho-grid-cell-rowspan').value)||1));
  const colSpan=Math.max(1,Math.round(Number(document.getElementById('kho-grid-cell-colspan').value)||1));
  if(!rawValue){alert(isLabel?'Chưa nhập nội dung ô tiêu đề.':'Chưa nhập mã Locator.');return;}
  if(!row||row<1||!col||col<1){alert('Hàng/Cột phải là số ≥ 1.');return;}
  if(row+rowSpan-1>layout.rows||col+colSpan-1>layout.cols){alert(`Vị trí này vượt ra ngoài lưới hiện tại (${layout.rows} hàng × ${layout.cols} cột).`);return;}
  const newCells=new Set();for(let r=row;r<row+rowSpan;r++)for(let c=col;c<col+colSpan;c++)newCells.add(r+','+c);
  const conflict=layout.cells.find(cell=>{
    if(cell.id===_khoGridEditingCellId)return false;
    for(let r=cell.row;r<cell.row+cell.rowSpan;r++)for(let c=cell.col;c<cell.col+cell.colSpan;c++)if(newCells.has(r+','+c))return true;
    return false;
  });
  if(conflict){alert(`Vị trí này đè lên ô "${conflict.isLabel?conflict.label:conflict.locator}" đã có sẵn trên lưới.`);return;}
  if(_khoGridEditingCellId){const cell=layout.cells.find(c=>c.id===_khoGridEditingCellId);if(cell){cell.isLabel=isLabel;cell.locator=locator;cell.label=label;cell.row=row;cell.col=col;cell.rowSpan=rowSpan;cell.colSpan=colSpan;}}
  else layout.cells.push({id:'g'+Date.now().toString(36)+Math.random().toString(36).slice(2,6),isLabel,locator,label,row,col,rowSpan,colSpan});
  khoGridSave();khoGridRenderCustom(kho);document.getElementById('kho-grid-cell-overlay').classList.remove('show');
});
// Nhấn Enter ở BẤT KỲ ô nhập nào trong popup này = bấm "Lưu" luôn, khỏi phải với chuột — trừ khi
// đang giữ Shift/Ctrl/Alt (dự phòng, tránh nuốt nhầm tổ hợp phím khác của trình duyệt).
['kho-grid-cell-locator','kho-grid-cell-row','kho-grid-cell-col','kho-grid-cell-rowspan','kho-grid-cell-colspan'].forEach(id=>{
  const el=document.getElementById(id);
  if(el) el.addEventListener('keydown',(e)=>{
    if(e.key==='Enter' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey){
      e.preventDefault();
      if(khoGridCellSaveBtn) khoGridCellSaveBtn.click();
    }
  });
});
const khoGridCellDeleteBtn=document.getElementById('kho-grid-cell-delete');
if(khoGridCellDeleteBtn) khoGridCellDeleteBtn.addEventListener('click',()=>{
  const kho=_khoGridActiveKho;if(!_khoGridEditingCellId)return;
  if(!confirm(`Xoá ô này khỏi lưới ${kho}? (không ảnh hưởng dữ liệu tồn kho thật)`))return;
  const layout=khoGridGetLayout(kho);layout.cells=layout.cells.filter(c=>c.id!==_khoGridEditingCellId);khoGridSave();khoGridRenderCustom(kho);document.getElementById('kho-grid-cell-overlay').classList.remove('show');
});

/* ============ SƠ ĐỒ RACK 3A ============
   "Sơ đồ mặc định" chỉ gồm đúng locator dạng "3A-##-T#" (VD: 3A-C12-T1, khu Rack) — danh sách đầy đủ
   510 vị trí (Dãy A-F, mỗi dãy 17 vị trí x 5 tầng T1-T5) lấy từ file RACK_3A.xlsx người dùng gửi, luôn
   hiển thị đủ tất cả vị trí, kể cả vị trí hiện chưa có pallet nào. Grid TUỲ CHỈNH thì không giới hạn —
   người dùng có thể tự thêm BẤT KỲ locator nào khác thuộc Kho 3A (VD khu Floor "DG3-FG-A01"), nên
   computeRack3AByLocator() bên dưới tính tồn kho cho MỌI locator thuộc Kho 3A, không chỉ đúng dạng
   Rack — mỗi dòng GI No. tính là 1 pallet. */
const RACK3A_MAX_PALLET = 2;
const RACK3A_ALL_LOCATORS = ["3A-A1-T1","3A-A2-T1","3A-A3-T1","3A-A4-T1","3A-A5-T1","3A-A6-T1","3A-A7-T1","3A-A8-T1","3A-A9-T1","3A-A10-T1","3A-A11-T1","3A-A12-T1","3A-A13-T1","3A-A14-T1","3A-A15-T1","3A-A16-T1","3A-A17-T1","3A-A1-T2","3A-A2-T2","3A-A3-T2","3A-A4-T2","3A-A5-T2","3A-A6-T2","3A-A7-T2","3A-A8-T2","3A-A9-T2","3A-A10-T2","3A-A11-T2","3A-A12-T2","3A-A13-T2","3A-A14-T2","3A-A15-T2","3A-A16-T2","3A-A17-T2","3A-A1-T3","3A-A2-T3","3A-A3-T3","3A-A4-T3","3A-A5-T3","3A-A6-T3","3A-A7-T3","3A-A8-T3","3A-A9-T3","3A-A10-T3","3A-A11-T3","3A-A12-T3","3A-A13-T3","3A-A14-T3","3A-A15-T3","3A-A16-T3","3A-A17-T3","3A-A1-T4","3A-A2-T4","3A-A3-T4","3A-A4-T4","3A-A5-T4","3A-A6-T4","3A-A7-T4","3A-A8-T4","3A-A9-T4","3A-A10-T4","3A-A11-T4","3A-A12-T4","3A-A13-T4","3A-A14-T4","3A-A15-T4","3A-A16-T4","3A-A17-T4","3A-A1-T5","3A-A2-T5","3A-A3-T5","3A-A4-T5","3A-A5-T5","3A-A6-T5","3A-A7-T5","3A-A8-T5","3A-A9-T5","3A-A10-T5","3A-A11-T5","3A-A12-T5","3A-A13-T5","3A-A14-T5","3A-A15-T5","3A-A16-T5","3A-A17-T5","3A-B1-T5","3A-B2-T5","3A-B3-T5","3A-B4-T5","3A-B5-T5","3A-B6-T5","3A-B7-T5","3A-B8-T5","3A-B9-T5","3A-B10-T5","3A-B11-T5","3A-B12-T5","3A-B13-T5","3A-B14-T5","3A-B15-T5","3A-B16-T5","3A-B17-T5","3A-B1-T4","3A-B2-T4","3A-B3-T4","3A-B4-T4","3A-B5-T4","3A-B6-T4","3A-B7-T4","3A-B8-T4","3A-B9-T4","3A-B10-T4","3A-B11-T4","3A-B12-T4","3A-B13-T4","3A-B14-T4","3A-B15-T4","3A-B16-T4","3A-B17-T4","3A-B1-T3","3A-B2-T3","3A-B3-T3","3A-B4-T3","3A-B5-T3","3A-B6-T3","3A-B7-T3","3A-B8-T3","3A-B9-T3","3A-B10-T3","3A-B11-T3","3A-B12-T3","3A-B13-T3","3A-B14-T3","3A-B15-T3","3A-B16-T3","3A-B17-T3","3A-B1-T2","3A-B2-T2","3A-B3-T2","3A-B4-T2","3A-B5-T2","3A-B6-T2","3A-B7-T2","3A-B8-T2","3A-B9-T2","3A-B10-T2","3A-B11-T2","3A-B12-T2","3A-B13-T2","3A-B14-T2","3A-B15-T2","3A-B16-T2","3A-B17-T2","3A-B1-T1","3A-B2-T1","3A-B3-T1","3A-B4-T1","3A-B5-T1","3A-B6-T1","3A-B7-T1","3A-B8-T1","3A-B9-T1","3A-B10-T1","3A-B11-T1","3A-B12-T1","3A-B13-T1","3A-B14-T1","3A-B15-T1","3A-B16-T1","3A-B17-T1","3A-C1-T1","3A-C2-T1","3A-C3-T1","3A-C4-T1","3A-C5-T1","3A-C6-T1","3A-C7-T1","3A-C8-T1","3A-C9-T1","3A-C10-T1","3A-C11-T1","3A-C12-T1","3A-C13-T1","3A-C14-T1","3A-C15-T1","3A-C16-T1","3A-C17-T1","3A-C1-T2","3A-C2-T2","3A-C3-T2","3A-C4-T2","3A-C5-T2","3A-C6-T2","3A-C7-T2","3A-C8-T2","3A-C9-T2","3A-C10-T2","3A-C11-T2","3A-C12-T2","3A-C13-T2","3A-C14-T2","3A-C15-T2","3A-C16-T2","3A-C17-T2","3A-C1-T3","3A-C2-T3","3A-C3-T3","3A-C4-T3","3A-C5-T3","3A-C6-T3","3A-C7-T3","3A-C8-T3","3A-C9-T3","3A-C10-T3","3A-C11-T3","3A-C12-T3","3A-C13-T3","3A-C14-T3","3A-C15-T3","3A-C16-T3","3A-C17-T3","3A-C1-T4","3A-C2-T4","3A-C3-T4","3A-C4-T4","3A-C5-T4","3A-C6-T4","3A-C7-T4","3A-C8-T4","3A-C9-T4","3A-C10-T4","3A-C11-T4","3A-C12-T4","3A-C13-T4","3A-C14-T4","3A-C15-T4","3A-C16-T4","3A-C17-T4","3A-C1-T5","3A-C2-T5","3A-C3-T5","3A-C4-T5","3A-C5-T5","3A-C6-T5","3A-C7-T5","3A-C8-T5","3A-C9-T5","3A-C10-T5","3A-C11-T5","3A-C12-T5","3A-C13-T5","3A-C14-T5","3A-C15-T5","3A-C16-T5","3A-C17-T5","3A-D1-T5","3A-D2-T5","3A-D3-T5","3A-D4-T5","3A-D5-T5","3A-D6-T5","3A-D7-T5","3A-D8-T5","3A-D9-T5","3A-D10-T5","3A-D11-T5","3A-D12-T5","3A-D13-T5","3A-D14-T5","3A-D15-T5","3A-D16-T5","3A-D17-T5","3A-D1-T4","3A-D2-T4","3A-D3-T4","3A-D4-T4","3A-D5-T4","3A-D6-T4","3A-D7-T4","3A-D8-T4","3A-D9-T4","3A-D10-T4","3A-D11-T4","3A-D12-T4","3A-D13-T4","3A-D14-T4","3A-D15-T4","3A-D16-T4","3A-D17-T4","3A-D1-T3","3A-D2-T3","3A-D3-T3","3A-D4-T3","3A-D5-T3","3A-D6-T3","3A-D7-T3","3A-D8-T3","3A-D9-T3","3A-D10-T3","3A-D11-T3","3A-D12-T3","3A-D13-T3","3A-D14-T3","3A-D15-T3","3A-D16-T3","3A-D17-T3","3A-D1-T2","3A-D2-T2","3A-D3-T2","3A-D4-T2","3A-D5-T2","3A-D6-T2","3A-D7-T2","3A-D8-T2","3A-D9-T2","3A-D10-T2","3A-D11-T2","3A-D12-T2","3A-D13-T2","3A-D14-T2","3A-D15-T2","3A-D16-T2","3A-D17-T2","3A-D1-T1","3A-D2-T1","3A-D3-T1","3A-D4-T1","3A-D5-T1","3A-D6-T1","3A-D7-T1","3A-D8-T1","3A-D9-T1","3A-D10-T1","3A-D11-T1","3A-D12-T1","3A-D13-T1","3A-D14-T1","3A-D15-T1","3A-D16-T1","3A-D17-T1","3A-E1-T1","3A-E2-T1","3A-E3-T1","3A-E4-T1","3A-E5-T1","3A-E6-T1","3A-E7-T1","3A-E8-T1","3A-E9-T1","3A-E10-T1","3A-E11-T1","3A-E12-T1","3A-E13-T1","3A-E14-T1","3A-E15-T1","3A-E16-T1","3A-E17-T1","3A-E1-T2","3A-E2-T2","3A-E3-T2","3A-E4-T2","3A-E5-T2","3A-E6-T2","3A-E7-T2","3A-E8-T2","3A-E9-T2","3A-E10-T2","3A-E11-T2","3A-E12-T2","3A-E13-T2","3A-E14-T2","3A-E15-T2","3A-E16-T2","3A-E17-T2","3A-E1-T3","3A-E2-T3","3A-E3-T3","3A-E4-T3","3A-E5-T3","3A-E6-T3","3A-E7-T3","3A-E8-T3","3A-E9-T3","3A-E10-T3","3A-E11-T3","3A-E12-T3","3A-E13-T3","3A-E14-T3","3A-E15-T3","3A-E16-T3","3A-E17-T3","3A-E1-T4","3A-E2-T4","3A-E3-T4","3A-E4-T4","3A-E5-T4","3A-E6-T4","3A-E7-T4","3A-E8-T4","3A-E9-T4","3A-E10-T4","3A-E11-T4","3A-E12-T4","3A-E13-T4","3A-E14-T4","3A-E15-T4","3A-E16-T4","3A-E17-T4","3A-E1-T5","3A-E2-T5","3A-E3-T5","3A-E4-T5","3A-E5-T5","3A-E6-T5","3A-E7-T5","3A-E8-T5","3A-E9-T5","3A-E10-T5","3A-E11-T5","3A-E12-T5","3A-E13-T5","3A-E14-T5","3A-E15-T5","3A-E16-T5","3A-E17-T5","3A-F1-T5","3A-F2-T5","3A-F3-T5","3A-F4-T5","3A-F5-T5","3A-F6-T5","3A-F7-T5","3A-F8-T5","3A-F9-T5","3A-F10-T5","3A-F11-T5","3A-F12-T5","3A-F13-T5","3A-F14-T5","3A-F15-T5","3A-F16-T5","3A-F17-T5","3A-F1-T4","3A-F2-T4","3A-F3-T4","3A-F4-T4","3A-F5-T4","3A-F6-T4","3A-F7-T4","3A-F8-T4","3A-F9-T4","3A-F10-T4","3A-F11-T4","3A-F12-T4","3A-F13-T4","3A-F14-T4","3A-F15-T4","3A-F16-T4","3A-F17-T4","3A-F1-T3","3A-F2-T3","3A-F3-T3","3A-F4-T3","3A-F5-T3","3A-F6-T3","3A-F7-T3","3A-F8-T3","3A-F9-T3","3A-F10-T3","3A-F11-T3","3A-F12-T3","3A-F13-T3","3A-F14-T3","3A-F15-T3","3A-F16-T3","3A-F17-T3","3A-F1-T2","3A-F2-T2","3A-F3-T2","3A-F4-T2","3A-F5-T2","3A-F6-T2","3A-F7-T2","3A-F8-T2","3A-F9-T2","3A-F10-T2","3A-F11-T2","3A-F12-T2","3A-F13-T2","3A-F14-T2","3A-F15-T2","3A-F16-T2","3A-F17-T2","3A-F1-T1","3A-F2-T1","3A-F3-T1","3A-F4-T1","3A-F5-T1","3A-F6-T1","3A-F7-T1","3A-F8-T1","3A-F9-T1","3A-F10-T1","3A-F11-T1","3A-F12-T1","3A-F13-T1","3A-F14-T1","3A-F15-T1","3A-F16-T1","3A-F17-T1"];

// CACHE theo tham chiếu currentData — cùng lý do với computeSodo3bByLocator() ở trên (gọi lại mỗi ký
// tự gõ tìm kiếm sơ đồ Rack 3A).
let _rack3aByLocatorCache = null, _rack3aByLocatorForData = null;
function computeRack3AByLocator(){
  if(_rack3aByLocatorForData === currentData && _rack3aByLocatorCache) return _rack3aByLocatorCache;
  const map = {};
  RACK3A_ALL_LOCATORS.forEach(loc => { map[loc] = []; });
  if(currentData){
    const raw = getRawRows(currentData);
    for(const row of raw){
      if(row[RAW_KEY_IDX.kho] !== 'Kho 3A') continue;
      const locator = row[RAW_KEY_IDX.locator] || '';
      if(!locator || PROD_LOCATOR_RE.test(locator)) continue;
      // TRƯỚC ĐÂY chỉ nhận đúng dạng Rack ("3A-##-T#") — "Sơ đồ mặc định" vẫn CHỈ hiện đúng danh sách
      // Rack (RACK3A_ALL_LOCATORS, không đổi), nhưng grid TUỲ CHỈNH cho phép người dùng tự thêm BẤT KỲ
      // locator nào thuộc Kho 3A (VD khu Floor "DG3-FG-A01") — nếu vẫn lọc chặt theo regex Rack, các ô
      // Floor tự thêm sẽ luôn hiện 0 dù có hàng thật (lỗi thật đã gặp). Bỏ lọc theo mẫu Rack, chỉ giữ
      // lọc "Prod" (giống mọi chỗ khác trong app) để map phản ánh đúng tồn kho thật cho MỌI locator.
      (map[locator] || (map[locator] = [])).push(row);
    }
  }
  _rack3aByLocatorCache = map;
  _rack3aByLocatorForData = currentData;
  return map;
}

function rack3aLocatorSortKey(loc){
  const idx = RACK3A_LOCATOR_ORDER.has(loc) ? RACK3A_LOCATOR_ORDER.get(loc) : RACK3A_ALL_LOCATORS.length;
  return [idx, String(loc || '')];
}
/* Thứ tự các vị trí trong RACK3A_ALL_LOCATORS đã đúng theo thứ tự đọc trong sơ đồ layout gốc
   (Dãy A: T1→T5, Dãy B: T5→T1, Dãy C: T1→T5, Dãy D: T5→T1…) nên chỉ cần giữ nguyên index này khi sắp xếp. */
const RACK3A_LOCATOR_ORDER = new Map(RACK3A_ALL_LOCATORS.map((loc, idx) => [loc, idx]));

/* Nhãn "RACK n · Dãy X" để chèn vạch ngăn cách giữa các dãy trên sơ đồ, giống cách nhóm trong file layout gốc. */
const RACK3A_LETTERS_IN_ORDER = [...new Set(RACK3A_ALL_LOCATORS.map(l => {
  const m = l.match(/^3A-([A-Za-z]+)\d+-T\d+$/i);
  return m ? m[1].toUpperCase() : '';
}).filter(Boolean))];
const RACK3A_LETTER_RACK_NUM = {};
RACK3A_LETTERS_IN_ORDER.forEach((letter, i) => { RACK3A_LETTER_RACK_NUM[letter] = Math.floor(i / 2) + 1; });

function rack3aGroupLabel(loc){
  const m = String(loc || '').match(/^3A-([A-Za-z]+)\d+-T\d+$/i);
  if(!m) return '';
  const letter = m[1].toUpperCase();
  const rackNum = RACK3A_LETTER_RACK_NUM[letter] || '?';
  return `RACK ${rackNum} · Dãy ${letter}`;
}

/* ============ Vẽ lưới ô kho kiểu chung (hiện chỉ còn dùng cho Sơ đồ Rack 3A — Sơ đồ kho 3B
   dùng renderSodo3bBlocks() riêng ở trên để chia khối màu) ============ */
const WH_GRID_CONFIGS = {}; // gridId -> { detailId, summaryId, computeFn, sortFn, maxPallet, emptyMsg, groupLabelFn }

function renderWhGrid(gridId){
  const cfg = WH_GRID_CONFIGS[gridId];
  if(!cfg) return;
  const grid = document.getElementById(gridId);
  const summaryEl = document.getElementById(cfg.summaryId);
  const detailWrap = document.getElementById(cfg.detailId);
  if(!grid) return;

  const map = cfg.computeFn();
  const locators = Object.keys(map).sort((a, b) => {
    const ka = cfg.sortFn(a), kb = cfg.sortFn(b);
    for(let i=0;i<ka.length;i++){
      if(ka[i] === kb[i]) continue;
      if(typeof ka[i] === 'string') return ka[i].localeCompare(kb[i]);
      return ka[i] - kb[i];
    }
    return 0;
  });

  if(detailWrap) detailWrap.innerHTML = '';

  if(!locators.length){
    grid.innerHTML = `<div class="wh3b-empty">${cfg.emptyMsg}</div>`;
    if(summaryEl) summaryEl.innerHTML = '';
    return;
  }

  let fullCount = 0, totalPallets = 0;
  let prevGroup = null;
  const boxesHtml = locators.map(loc => {
    const rows = map[loc] || [];
    const b = buildLocatorBoxHtml(loc, rows, cfg.maxPallet, '');
    totalPallets += b.count;
    if(b.level === 'full') fullCount++;
    let dividerHtml = '';
    if(cfg.groupLabelFn){
      const group = cfg.groupLabelFn(loc);
      if(group !== prevGroup){
        dividerHtml = `<div class="wh3b-group-divider">${group}</div>`;
        prevGroup = group;
      }
    }
    return dividerHtml + b.html;
  }).join('');

  grid.innerHTML = boxesHtml;

  if(summaryEl){
    summaryEl.innerHTML = `
      <div><b>${locators.length}</b><span>Vị trí (locator)</span></div>
      <div><b>${fmt(totalPallets)}</b><span>Tổng pallet (dòng GI No.)</span></div>
      <div><b>${fullCount}</b><span>Vị trí đầy / gần đầy (≥ 80%)</span></div>
    `;
  }
}

/* Tìm kiếm + lọc PASS/NG trên sơ đồ kho — locator có ít nhất 1 dòng khớp thì "sáng lên"
   (wh3b-highlight), locator không khớp thì "tối lại" (wh3b-dim). Mặc định (chưa gõ gì, cả
   PASS+NG đều được chọn) thì không tô gì cả, hiển thị bình thường. Khi đang lọc, tự hiện luôn
   bảng "Chi tiết vị trí" gồm đúng các dòng khớp (gộp mọi locator sáng lên), không cần bấm vào
   từng ô. */
function whApplySearchFilter(gridId, computeFn, searchInputId, passChkId, ngChkId, detailId){
  const grid = document.getElementById(gridId);
  const searchInput = document.getElementById(searchInputId);
  if(!grid || !searchInput) return;
  const passChk = document.getElementById(passChkId);
  const ngChk = document.getElementById(ngChkId);
  const showPass = passChk ? passChk.checked : true;
  const showNg = ngChk ? ngChk.checked : true;
  const query = searchInput.value.trim();
  const isFiltering = !!query || !showPass || !showNg;
  const groups = query ? parseMultiCodes(query) : [];
  const map = computeFn();

  const matchedRows = [];
  const matchedLocators = new Set();
  grid.querySelectorAll('.wh3b-box[data-locator]').forEach(boxEl => {
    boxEl.classList.remove('wh3b-dim', 'wh3b-highlight');
    if(!isFiltering) return;
    const loc = boxEl.dataset.locator;
    const rows = map[loc] || [];
    const matchingRows = rows.filter(r => {
      const oqcUp = String(r[RAW_KEY_IDX.oqc] || '').toUpperCase();
      const isNg = oqcUp.includes('NG');
      if(isNg && !showNg) return false;
      if(!isNg && !showPass) return false;
      if(!query) return true;
      const hay = `${r[RAW_KEY_IDX.item]} ${r[RAW_KEY_IDX.custpo]} ${r[RAW_KEY_IDX.locator]}`.toLowerCase();
      return multiGroupMatch(groups, hay);
    });
    if(matchingRows.length){
      boxEl.classList.add('wh3b-highlight');
      matchedLocators.add(loc);
      matchingRows.forEach(r => matchedRows.push(r));
    } else {
      boxEl.classList.add('wh3b-dim');
    }
  });

  const detailWrap = detailId ? document.getElementById(detailId) : null;
  if(!detailWrap) return;
  document.querySelectorAll('#' + gridId + ' .wh3b-box.active').forEach(b => b.classList.remove('active'));
  if(!isFiltering){
    detailWrap.innerHTML = '';
    return;
  }
  if(!matchedRows.length){
    detailWrap.innerHTML = `<div class="wh3b-empty">Không có dòng nào khớp tìm kiếm/lọc.</div>`;
    return;
  }
  const rowsSorted = matchedRows.slice().sort((a, b) =>
    String(a[RAW_KEY_IDX.locator] || '').localeCompare(String(b[RAW_KEY_IDX.locator] || '')) ||
    String(a[RAW_KEY_IDX.item] || '').localeCompare(String(b[RAW_KEY_IDX.item] || '')));
  const body = rowsSorted.map((r, idx) => `
    <tr>
      <td>${idx + 1}</td>
      <td>${r[RAW_KEY_IDX.locator] || ''}</td>
      <td>${r[RAW_KEY_IDX.item] || ''}</td>
      <td>${r[RAW_KEY_IDX.custpo] || ''}</td>
      <td>${oqcBadge(r[RAW_KEY_IDX.oqc])}</td>
      <td class="num">${fmt(r[RAW_KEY_IDX.qty] || 0)}</td>
      <td>${giCellHtml(r[RAW_KEY_IDX.gi])}</td>
      <td>${r[RAW_KEY_IDX.lot] || '—'}</td>
    </tr>`).join('');
  detailWrap.innerHTML = `
    <div class="wh3b-detail-title">Kết quả tìm/lọc — <b>${fmt(matchedLocators.size)}</b> vị trí, ${fmt(rowsSorted.length)} pallet (dòng GI No.)</div>
    <div class="plan-table-wrap">
      <table class="plan-detail-table">
        <thead><tr><th>#</th><th>Locator</th><th>Item No.</th><th>Cust PO</th><th>OQC</th><th style="text-align:right">SL tồn</th><th>GI No.</th><th>Lot No.</th></tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>`;
}

['sodo3b', 'rack3a', 'sodo2b'].forEach(prefix => {
  const detailId = prefix + '-detail';
  const computeFn = prefix === 'sodo3b' ? computeSodo3bByLocator : computeRack3AByLocator;
  const apply = () => {
    const khoForPrefix = prefix === 'sodo3b' ? 'Kho 3B' : (prefix === 'rack3a' ? 'Kho 3A' : 'Kho 2B');
    const cfgForPrefix = KHO_CUSTOM_GRID_CONFIG[khoForPrefix];
    const gridId = khoGridIsCustomMode(khoForPrefix) ? cfgForPrefix.customGrid : cfgForPrefix.defaultGrid;
    whApplySearchFilter(gridId, computeFn, prefix + '-search', prefix + '-oqc-pass', prefix + '-oqc-ng', detailId);
  };
  const searchEl = document.getElementById(prefix + '-search');
  if(searchEl) searchEl.addEventListener('input', debounce(apply, 150));
  [prefix + '-oqc-pass', prefix + '-oqc-ng'].forEach(id => {
    const el = document.getElementById(id);
    if(el) el.addEventListener('change', apply);
  });
});

function renderSodo3B(){
  renderSodo3bBlocks();
  renderWhGrid('rack3a-grid');
  renderWhGrid('sodo2b-grid');
  if(khoGridIsCustomMode('Kho 3B')) khoGridRenderCustom('Kho 3B');
  else whApplySearchFilter('sodo3b-grid', computeSodo3bByLocator, 'sodo3b-search', 'sodo3b-oqc-pass', 'sodo3b-oqc-ng', 'sodo3b-detail');
  if(khoGridIsCustomMode('Kho 3A')) khoGridRenderCustom('Kho 3A');
  else whApplySearchFilter('rack3a-grid', computeRack3AByLocator, 'rack3a-search', 'rack3a-oqc-pass', 'rack3a-oqc-ng', 'rack3a-detail');
  if(khoGridIsCustomMode('Kho 2B')) khoGridRenderCustom('Kho 2B');
  else whApplySearchFilter('sodo2b-grid', computeSodo2bByLocator, 'sodo2b-search', 'sodo2b-oqc-pass', 'sodo2b-oqc-ng', 'sodo2b-detail');
}

WH_GRID_CONFIGS['sodo3b-grid'] = {
  detailId: 'sodo3b-detail', computeFn: computeSodo3bByLocator
}; // dùng bởi handler click chi tiết bên dưới — renderWhGrid() không còn dùng cho id này
WH_GRID_CONFIGS['sodo3b-custom-grid'] = {
  detailId: 'sodo3b-detail', computeFn: computeSodo3bByLocator
}; // grid TUỲ CHỈNH — dùng chung computeFn/detailId với sơ đồ mặc định, chỉ khác cách bố trí ô
WH_GRID_CONFIGS['rack3a-grid'] = {
  detailId: 'rack3a-detail', summaryId: 'rack3a-summary',
  computeFn: computeRack3AByLocator, sortFn: rack3aLocatorSortKey, maxPallet: RACK3A_MAX_PALLET,
  emptyMsg: 'Không tải được danh sách vị trí Rack 3A.', groupLabelFn: rack3aGroupLabel
};
WH_GRID_CONFIGS['sodo2b-grid'] = {
  detailId:'sodo2b-detail', summaryId:'sodo2b-summary',
  computeFn:computeSodo2bByLocator, sortFn:(loc)=>[String(loc||'')], maxPallet:24,
  emptyMsg:'Không có dữ liệu tồn kho cho Kho 2B.', groupLabelFn:null
};
WH_GRID_CONFIGS['sodo3b-custom-grid'] = {detailId:'sodo3b-detail',computeFn:computeSodo3bByLocator};
WH_GRID_CONFIGS['rack3a-custom-grid'] = {detailId:'rack3a-detail',computeFn:computeRack3AByLocator};
WH_GRID_CONFIGS['sodo2b-custom-grid'] = {detailId:'sodo2b-detail',computeFn:computeSodo2bByLocator};

document.addEventListener('click', (e) => {
  const outsideWarnBtn = e.target.closest('#wh3b-outside-warning');
  if(outsideWarnBtn){
    const detailWrap = document.getElementById('sodo3b-detail');
    if(!detailWrap) return;
    document.querySelectorAll('#sodo3b-grid .wh3b-box.active').forEach(b => b.classList.remove('active'));
    const rows = sodo3bOutsideData.rows.slice().sort((a, b) =>
      String(a[RAW_KEY_IDX.locator] || '').localeCompare(String(b[RAW_KEY_IDX.locator] || '')) ||
      String(a[RAW_KEY_IDX.item] || '').localeCompare(String(b[RAW_KEY_IDX.item] || '')));
    const body = rows.map((r, idx) => `
      <tr>
        <td>${idx + 1}</td>
        <td>${r[RAW_KEY_IDX.locator] || ''}</td>
        <td>${r[RAW_KEY_IDX.item] || ''}</td>
        <td>${r[RAW_KEY_IDX.custpo] || ''}</td>
        <td>${oqcBadge(r[RAW_KEY_IDX.oqc])}</td>
        <td class="num">${fmt(r[RAW_KEY_IDX.qty] || 0)}</td>
        <td>${giCellHtml(r[RAW_KEY_IDX.gi])}</td>
        <td>${r[RAW_KEY_IDX.lot] || '—'}</td>
      </tr>`).join('');
    detailWrap.innerHTML = `
      <div class="wh3b-detail-title">⚠ ${fmt(sodo3bOutsideData.locators.length)} vị trí NGOÀI sơ đồ (<b>${sodo3bOutsideData.locators.join(', ')}</b>) — ${fmt(rows.length)} pallet (dòng GI No.)</div>
      <div class="plan-table-wrap">
        <table class="plan-detail-table">
          <thead><tr><th>#</th><th>Locator</th><th>Item No.</th><th>Cust PO</th><th>OQC</th><th style="text-align:right">SL tồn</th><th>GI No.</th><th>Lot No.</th></tr></thead>
          <tbody>${body}</tbody>
        </table>
      </div>`;
    detailWrap.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    return;
  }

  const gearBtn = e.target.closest('.wh3b-box-gear');
  if(gearBtn){
    const loc = gearBtn.dataset.locator;
    const defaultMax = Number(gearBtn.dataset.defaultMax) || 1;
    const overrides = whLoadCapOverrides();
    const current = overrides[loc] || defaultMax;
    const val = prompt(`Sức chứa tối đa (pallet) cho vị trí "${loc}":\n(Mặc định: ${defaultMax})`, current);
    if(val === null) return; // bấm Huỷ
    const trimmed = val.trim();
    if(trimmed === ''){
      delete overrides[loc]; // để trống -> xoá ghi đè, quay lại mặc định
    } else {
      const num = Number(trimmed);
      if(!Number.isFinite(num) || num <= 0){ alert('Giá trị không hợp lệ — hãy nhập 1 số lớn hơn 0.'); return; }
      overrides[loc] = num;
    }
    whSaveCapOverrides(overrides);
    renderSodo3B();
    if(typeof renderCapacityOverviews === 'function') renderCapacityOverviews(); // đồng bộ sang trang Overview
    return;
  }

  const box = e.target.closest('.wh3b-box-main');
  if(!box) return;
  const boxEl = box.closest('.wh3b-box');
  const gridEl = box.closest('.wh3b-grid');
  const cfg = gridEl ? WH_GRID_CONFIGS[gridEl.id] : null;
  if(!cfg || !boxEl) return;
  const detailWrap = document.getElementById(cfg.detailId);
  const wasActive = boxEl.classList.contains('active');
  gridEl.querySelectorAll('.wh3b-box.active').forEach(b => b.classList.remove('active'));
  if(wasActive){
    if(detailWrap) detailWrap.innerHTML = '';
    return;
  }
  boxEl.classList.add('active');
  if(!detailWrap) return;
  const loc = box.dataset.locator;
  const map = cfg.computeFn();
  const rows = (map[loc] || []).slice().sort((a, b) =>
    String(a[RAW_KEY_IDX.item] || '').localeCompare(String(b[RAW_KEY_IDX.item] || '')));
  const body = rows.map((r, idx) => `
    <tr>
      <td>${idx + 1}</td>
      <td>${r[RAW_KEY_IDX.item] || ''}</td>
      <td>${r[RAW_KEY_IDX.custpo] || ''}</td>
      <td>${oqcBadge(r[RAW_KEY_IDX.oqc])}</td>
      <td class="num">${fmt(r[RAW_KEY_IDX.qty] || 0)}</td>
      <td>${giCellHtml(r[RAW_KEY_IDX.gi])}</td>
      <td>${r[RAW_KEY_IDX.lot] || '—'}</td>
    </tr>`).join('');
  detailWrap.innerHTML = `
    <div class="wh3b-detail-title">Chi tiết vị trí <b>${loc}</b> — ${fmt(rows.length)} pallet (dòng GI No.)</div>
    <div class="plan-table-wrap">
      <table class="plan-detail-table">
        <thead><tr><th>#</th><th>Item No.</th><th>Cust PO</th><th>OQC</th><th style="text-align:right">SL tồn</th><th>GI No.</th><th>Lot No.</th></tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>`;
});

/* Tạo 1 bộ điều khiển tìm kiếm độc lập (tab, ô search, ô multi, bảng gộp, bảng dữ liệu gốc).
   Dùng để nhân bản y hệt chức năng "Tìm mã hàng" cho nhiều mục sidebar khác nhau
   (VD: tab "Tìm mã hàng" và tab "Kiểm tồn kho") mà không đụng chạm lẫn nhau. */
function createSearchController(ids){
  const khoTabsEl = document.getElementById(ids.tabs);
  const khoSearchEl = document.getElementById(ids.search);
  const khoMultiSearchEl = document.getElementById(ids.multiSearch);
  const btnClearMulti = document.getElementById(ids.clearBtn);
  const khoSummaryEl = document.getElementById(ids.summary);
  const khoTable = document.getElementById(ids.table);
  const khoTbody = document.getElementById(ids.tbody);
  const khoEmptyEl = document.getElementById(ids.empty);
  const rawTableEl = document.getElementById(ids.rawTable);
  const rawTbody = document.getElementById(ids.rawTbody);
  const rawEmptyEl = document.getElementById(ids.rawEmpty);
  const rawSummaryEl = document.getElementById(ids.rawSummary);
  if(!khoTabsEl) return null;

  // ============ Bộ lọc theo cột (kiểu Excel) — chỉ bật khi ids.enableColumnFilters ============
  const enableColFilters = !!ids.enableColumnFilters;
  const KHO_FILTER_COLS = ['kho','item','custpo','locator','oqc'];
  const RAW_FILTER_COLS = ['kho','item','custpo','locator','oqc','gi','lot','pallet','dt','buyer','ref'];
  const khoColFilters = {};
  const rawColFilters = {};
  let khoRowsForFilterValues = [];
  let rawRowsForFilterValues = [];
  let lastRawRenderedRows = [];
  let activeFilterDropdown = null; // { el }

  function colFilterValueLabel(v){
    return (v === undefined || v === null || v === '') ? '(trống)' : String(v);
  }
  function applyColFilters(filtersObj, rows, getVal){
    const activeCols = Object.keys(filtersObj).filter(c => filtersObj[c] && filtersObj[c].size);
    if(!activeCols.length) return rows;
    return rows.filter(r => activeCols.every(c => filtersObj[c].has(colFilterValueLabel(getVal(r, c)))));
  }
  function anyColFilterActive(filtersObj){
    return Object.keys(filtersObj).some(c => filtersObj[c] && filtersObj[c].size);
  }
  function updateFilterIcons(tableEl, filtersObj){
    if(!tableEl) return;
    tableEl.querySelectorAll('.th-filter-btn').forEach(btn => {
      const active = !!(filtersObj[btn.dataset.col] && filtersObj[btn.dataset.col].size);
      btn.style.opacity = active ? '1' : '0.55';
      btn.style.color = active ? 'var(--blue)' : 'inherit';
    });
  }
  function closeFilterDropdown(){
    if(activeFilterDropdown){ activeFilterDropdown.el.remove(); activeFilterDropdown = null; }
    document.removeEventListener('mousedown', outsideDropdownHandler, true);
  }
  function outsideDropdownHandler(e){
    if(activeFilterDropdown && !activeFilterDropdown.el.contains(e.target)) closeFilterDropdown();
  }
  function openColumnFilterDropdown(kind, colKey, btn){
    if(activeFilterDropdown && activeFilterDropdown.kind === kind && activeFilterDropdown.col === colKey){
      closeFilterDropdown();
      return;
    }
    closeFilterDropdown();
    const isKho = kind === 'kho';
    const filtersObj = isKho ? khoColFilters : rawColFilters;
    const baseRows = isKho ? khoRowsForFilterValues : rawRowsForFilterValues;
    const getVal = isKho ? ((r,c)=>r[c]) : ((r,c)=>r[RAW_KEY_IDX[c]]);
    const valueSet = new Set();
    baseRows.forEach(r => valueSet.add(colFilterValueLabel(getVal(r, colKey))));
    const values = Array.from(valueSet).sort((a,b) => a.localeCompare(b, 'vi'));
    const currentSet = filtersObj[colKey];
    const rect = btn.getBoundingClientRect();
    const panel = document.createElement('div');
    panel.className = 'tx-filter-dropdown';
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - 260));
    panel.style.cssText = `position:fixed; top:${rect.bottom+4}px; left:${left}px; width:240px; max-height:340px; overflow:auto; background:#fff; border:1px solid var(--line); border-radius:10px; box-shadow:0 12px 32px rgba(0,0,0,0.18); z-index:9999; padding:10px; font-family:var(--mono);`;

    const isAllSelected = !currentSet;
    const checklistHtml = values.map(v => {
      const checked = isAllSelected || currentSet.has(v);
      return `<label style="display:flex; align-items:center; gap:8px; padding:5px 4px; font-size:12.5px; cursor:pointer; border-radius:6px;">
        <input type="checkbox" class="tx-filter-chk" value="${escAttr(v)}" ${checked ? 'checked' : ''}>
        <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escHtml(v)}</span>
      </label>`;
    }).join('') || '<div style="font-size:12px; color:var(--muted); padding:6px 2px;">Không có giá trị</div>';

    panel.innerHTML = `
      <input type="text" class="tx-filter-search-inner" placeholder="Tìm giá trị…" style="width:100%; box-sizing:border-box; border:1px solid var(--line); border-radius:6px; padding:7px 9px; font-size:12.5px; margin-bottom:8px; outline:none;">
      <div style="display:flex; gap:12px; margin-bottom:6px;">
        <button type="button" class="tx-filter-selall" style="font-size:11.5px; border:none; background:none; color:var(--blue); cursor:pointer; padding:0;">Chọn tất cả</button>
        <button type="button" class="tx-filter-clrall" style="font-size:11.5px; border:none; background:none; color:var(--blue); cursor:pointer; padding:0;">Bỏ chọn</button>
      </div>
      <div class="tx-filter-list">${checklistHtml}</div>
      <div style="display:flex; gap:8px; margin-top:10px; border-top:1px solid var(--line); padding-top:8px;">
        <button type="button" class="tx-filter-apply btn-update" style="flex:1; padding:6px 8px; font-size:12px; justify-content:center;">Áp dụng</button>
        <button type="button" class="tx-filter-reset btn-update btn-danger" style="flex:1; padding:6px 8px; font-size:12px; justify-content:center;">Xoá lọc</button>
      </div>
    `;
    document.body.appendChild(panel);
    activeFilterDropdown = { kind, col: colKey, el: panel };
    setTimeout(() => document.addEventListener('mousedown', outsideDropdownHandler, true), 0);

    const searchInner = panel.querySelector('.tx-filter-search-inner');
    searchInner.focus();
    searchInner.addEventListener('input', () => {
      const q = removeDiacritics(searchInner.value.toLowerCase().trim());
      panel.querySelectorAll('.tx-filter-list label').forEach(lbl => {
        lbl.style.display = removeDiacritics(lbl.textContent.toLowerCase()).includes(q) ? 'flex' : 'none';
      });
    });
    panel.querySelector('.tx-filter-selall').addEventListener('click', () => {
      panel.querySelectorAll('.tx-filter-list label').forEach(lbl => {
        if(lbl.style.display !== 'none'){ const c = lbl.querySelector('.tx-filter-chk'); if(c) c.checked = true; }
      });
    });
    panel.querySelector('.tx-filter-clrall').addEventListener('click', () => {
      panel.querySelectorAll('.tx-filter-list label').forEach(lbl => {
        if(lbl.style.display !== 'none'){ const c = lbl.querySelector('.tx-filter-chk'); if(c) c.checked = false; }
      });
    });
    panel.querySelector('.tx-filter-apply').addEventListener('click', () => {
      const checked = Array.from(panel.querySelectorAll('.tx-filter-chk')).filter(c => c.checked).map(c => c.value);
      if(checked.length === 0 || checked.length === values.length) delete filtersObj[colKey];
      else filtersObj[colKey] = new Set(checked);
      closeFilterDropdown();
      if(isKho) renderKhoTable(); else renderRawTable();
    });
    panel.querySelector('.tx-filter-reset').addEventListener('click', () => {
      delete filtersObj[colKey];
      closeFilterDropdown();
      if(isKho) renderKhoTable(); else renderRawTable();
    });
  }
  function addFilterButtonsToHeaders(tableEl, kind, cols){
    if(!tableEl || !enableColFilters) return;
    tableEl.querySelectorAll('thead th[data-key]').forEach(th => {
      const key = th.dataset.key;
      if(!cols.includes(key) || th.querySelector('.th-filter-btn')) return;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'th-filter-btn';
      btn.dataset.col = key;
      btn.title = 'Lọc theo giá trị';
      btn.style.cssText = 'margin-left:6px; border:none; background:none; cursor:pointer; color:inherit; opacity:0.55; vertical-align:middle; padding:2px;';
      btn.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="3 4 21 4 14 12.5 14 19 10 21 10 12.5 3 4"></polygon></svg>';
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        openColumnFilterDropdown(kind, key, btn);
      });
      th.appendChild(btn);
    });
  }

  let activeKho = null;
  let sortKey = (ids.table === 'kt-detail-table') ? 'locator' : 'qty';
  let sortDir = (ids.table === 'kt-detail-table') ? 1 : -1;
  let rawSortIdx = 5;
  let rawSortDir = -1;

  function renderRawTable(){
    if(!rawTbody || !currentData) return;
    const multiCodes = parseMultiCodes(khoMultiSearchEl ? khoMultiSearchEl.value : '');
    const multiMode = multiCodes.length > 0;
    if(rawTableEl) rawTableEl.classList.toggle('show-kho', multiMode);

    const raw = getRawRows(currentData);
    let rows, totalQty;
    // Nhớ lại chuỗi "hay" (đã ghép + viết thường) đã tính cho từng dòng ngay khi lọc — dùng lại ở phần
    // tính "matchedCodesCount" bên dưới thay vì tính lại lần 2 (map theo THAM CHIẾU dòng nên vẫn đúng
    // dù `rows` sau đó còn bị lọc cột/sắp xếp thêm — chỉ tạo mới mỗi lần render, không lưu xuyên suốt).
    const multiHayMap = multiMode ? new Map() : null;
    if(multiMode){
      rows = raw.filter(r => {
        const hay = `${r[1]} ${r[2]} ${r[3]} ${r[4]} ${r[6]} ${r[7]} ${r[8]} ${r[9]} ${r[10]} ${r[11]}`.toLowerCase();
        multiHayMap.set(r, hay);
        return multiGroupMatch(multiCodes, hay);
      });
    } else {
      const khoRows = raw.filter(r => r[0] === activeKho);
      totalQty = khoRows.reduce((s,r)=>s+r[5],0);
      rows = khoRows;
      const terms = khoSearchEl ? khoSearchEl.value.trim().toLowerCase().split(/\s+/).filter(Boolean) : [];
      if(terms.length){
        rows = rows.filter(r => {
          const hay = `${r[1]} ${r[2]} ${r[3]} ${r[6]} ${r[7]} ${r[8]} ${r[10]} ${r[11]}`.toLowerCase();
          return terms.every(t => hay.includes(t));
        });
      }
    }

    rawRowsForFilterValues = rows;
    if(enableColFilters) rows = applyColFilters(rawColFilters, rows, (r,c) => r[RAW_KEY_IDX[c]]);
    updateFilterIcons(rawTableEl, rawColFilters);
    const rawClearBtn = document.getElementById(ids.rawClearFilters);
    if(rawClearBtn) rawClearBtn.style.display = anyColFilterActive(rawColFilters) ? 'inline' : 'none';

    rows = [...rows].sort((a,b) => {
      const va = a[rawSortIdx], vb = b[rawSortIdx];
      if(rawSortIdx === 5) return (va - vb) * rawSortDir;
      return String(va || '').localeCompare(String(vb || '')) * rawSortDir;
    });

    if(rawSummaryEl){
      const foundQty = rows.reduce((s,r)=>s+r[5],0);
      if(multiMode){
        const matchedCodesCount = multiCodes.filter(g => rows.some(r => {
          const hay = multiHayMap.get(r);
          return g.every(tok => hay.includes(tok));
        })).length;
        rawSummaryEl.innerHTML = `<b>${fmt(foundQty)}</b> Pcs &nbsp;·&nbsp; ${rows.length} dòng &nbsp;·&nbsp; khớp ${matchedCodesCount}/${multiCodes.length} mã tìm`;
      } else {
        rawSummaryEl.innerHTML = `<b>${fmt(foundQty)}</b> / ${fmt(totalQty)} Pcs &nbsp;·&nbsp; ${rows.length} dòng`;
      }
    }

    if(!rows.length){
      rawTbody.innerHTML = '';
      if(rawEmptyEl){ rawEmptyEl.style.display = 'block'; rawEmptyEl.textContent = multiMode ? 'Không tìm thấy mã hàng nào khớp ở cả 4 kho' : 'Không có dòng nào khớp tìm kiếm'; }
      lastRawRenderedRows = [];
      return;
    }
    if(rawEmptyEl) rawEmptyEl.style.display = 'none';

    lastRawRenderedRows = rows;
    rawTbody.innerHTML = rows.map(r => `
      <tr>
        <td class="col-kho">${r[0].replace('Kho ','')}</td>
        <td>${r[1]}</td>
        <td>${r[2]}</td>
        <td>${r[3]}</td>
        <td>${oqcBadge(r[4])}</td>
        <td class="num">${fmt(r[5])}</td>
        <td>${giCellHtml(r[6])}</td>
        <td>${r[7] || '—'}</td>
        <td>${r[8] || '—'}</td>
        <td>${r[9] || '—'}</td>
        <td>${r[10] || '—'}</td>
        <td>${r[11] || '—'}</td>
      </tr>`).join('');
  }

  /* Xuất Excel — đúng theo dữ liệu đang hiển thị ở bảng "Chi tiết từng dòng"
     (đã áp dụng tìm kiếm / MULTI / bộ lọc cột / sắp xếp), cộng thêm cột mã QR (GI No.) ở cuối. */
  async function exportRawTableToExcel(){
    if(!lastRawRenderedRows.length){ alert('Không có dữ liệu để xuất — bảng đang trống hoặc không khớp bộ lọc.'); return; }
    if(!LIB_EXCELJS_OK){ alert('Không tải được thư viện xuất Excel (cần Internet). Vui lòng thử lại.'); return; }
    const overlay = document.getElementById('loading-overlay');
    const loadingMsg = document.getElementById('loading-msg');
    if(overlay) overlay.classList.add('show');
    try{
      const rows = lastRawRenderedRows;
      if(loadingMsg) loadingMsg.textContent = `Đang tạo mã QR (0/${rows.length})…`;

      const workbook = new ExcelJS.Workbook();
      workbook.creator = 'TN5 Dashboard';
      workbook.created = new Date();
      const ws = workbook.addWorksheet('Chi tiet tung dong');

      const headers = ['Kho','Item No.','Cust PO','Locator','OQC','SL','GI No.','Lot No.','Pallet','Ngày nhận','Buyer','CSR/Ref','QR Code'];
      ws.addRow(headers);
      const headerRow = ws.getRow(1);
      headerRow.font = { bold: true };
      headerRow.height = 20;
      headerRow.eachCell(cell => {
        cell.fill = { type:'pattern', pattern:'solid', fgColor:{ argb:'FFEFEFEF' } };
        cell.alignment = { vertical:'middle', horizontal:'center' };
        cell.border = { bottom: { style:'thin', color:{ argb:'FFCCCCCC' } } };
      });
      ws.columns = [
        {width:9},{width:16},{width:14},{width:16},{width:8},{width:10},
        {width:20},{width:34},{width:9},{width:13},{width:12},{width:12},{width:20}
      ];

      const qrColIndex = headers.length - 1; // 0-based cột QR để neo ảnh
      const QR_ROW_HEIGHT = 104; // pt — đủ cao cho ảnh 135x135px

      for(let i=0;i<rows.length;i++){
        const r = rows[i];
        const excelRowNum = i + 2; // dòng 1 là header
        ws.addRow([
          String(r[0]||'').replace('Kho ',''),
          r[1] || '',
          r[2] || '',
          r[3] || '',
          r[4] || '',
          typeof r[5] === 'number' ? r[5] : (parseFloat(r[5]) || 0),
          r[6] || '',
          r[7] || '',
          r[8] || '',
          r[9] || '',
          r[10] || '',
          r[11] || '',
          ''
        ]);
        ws.getRow(excelRowNum).height = QR_ROW_HEIGHT;
        ws.getRow(excelRowNum).alignment = { vertical:'middle' };

        const giVal = r[6] ? String(r[6]).trim() : '';
        if(giVal){
          const dataUrl = generateQrDataUrl(giVal);
          if(dataUrl){
            const imgId = workbook.addImage({ base64: dataUrl, extension: 'png' });
            ws.addImage(imgId, { tl: { col: qrColIndex, row: excelRowNum - 1 }, ext: { width: QR_EXPORT_PX, height: QR_EXPORT_PX }, editAs: 'oneCell' });
          }
        }

        // Nhường luồng chính định kỳ để UI không bị treo, đồng thời cập nhật tiến độ
        if(i % 150 === 0 || i === rows.length - 1){
          if(loadingMsg) loadingMsg.textContent = `Đang tạo mã QR (${i+1}/${rows.length})…`;
          await new Promise(res => setTimeout(res, 0));
        }
      }

      if(loadingMsg) loadingMsg.textContent = 'Đang lưu file Excel…';
      const buffer = await workbook.xlsx.writeBuffer();
      const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const stamp = fmtDateTime(new Date()).replace(/[/: ]/g, '-');
      a.href = url;
      a.download = `ChiTietTungDong_${stamp}.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    }catch(err){
      console.error('Lỗi xuất Excel:', err);
      alert('Có lỗi khi xuất Excel: ' + err.message);
    }finally{
      if(overlay) overlay.classList.remove('show');
    }
  }

  function renderKhoTable(){
    if(!currentData) return;
    const multiCodes = parseMultiCodes(khoMultiSearchEl ? khoMultiSearchEl.value : '');
    const multiMode = multiCodes.length > 0;

    if(khoTable) khoTable.classList.toggle('show-kho', multiMode);
    if(khoSearchEl){
      khoSearchEl.disabled = multiMode;
      khoSearchEl.placeholder = multiMode
        ? 'Đang tìm nhiều mã ở tất cả kho — xoá ô phía trên để lọc theo từng kho'
        : 'Tìm theo Item No., Cust PO hoặc Locator…';
    }
    if(khoTabsEl){
      [...khoTabsEl.children].forEach(c => c.classList.toggle('disabled', multiMode));
    }

    let rowsAll, totalQty;
    // Nhớ lại chuỗi "hay" đã tính cho từng dòng ngay khi lọc — dùng lại ở "matchedCodesCount" bên dưới
    // thay vì tính lại lần 2 (map theo THAM CHIẾU dòng nên vẫn đúng dù rowsAll/rows sau đó còn bị lọc
    // cột/sắp xếp thêm — chỉ tạo mới mỗi lần render, không lưu xuyên suốt).
    const multiHayMap = multiMode ? new Map() : null;
    if(multiMode){
      rowsAll = [];
      for(const kho of (currentData.kho_order || Object.keys(currentData.kho_detail))){
        for(const [item, custpo, locator, oqc, qty] of (currentData.kho_detail[kho] || [])){
          rowsAll.push({kho, item, custpo, locator, oqc, qty});
        }
      }
      rowsAll = rowsAll.filter(r => {
        const hay = `${r.item} ${r.custpo} ${r.locator} ${r.oqc} ${r.kho}`.toLowerCase();
        multiHayMap.set(r, hay);
        return multiGroupMatch(multiCodes, hay);
      });
      totalQty = rowsAll.reduce((s,r)=>s+r.qty,0);
    } else {
      rowsAll = (currentData.kho_detail[activeKho] || []).map(([item, custpo, locator, oqc, qty]) => ({kho: activeKho, item, custpo, locator, oqc, qty}));
      // Kiểm tồn kho: gộp thêm các dòng "sai vị trí" được tự thêm khi quét QR (mã+PO không có sẵn
      // tại locator hệ thống ghi nhận) — không đụng tới bảng "Tìm mã hàng".
      if(ids.table === 'kt-detail-table' && scannedExtraRows[activeKho] && scannedExtraRows[activeKho].length){
        rowsAll = rowsAll.concat(scannedExtraRows[activeKho]);
      }
      totalQty = rowsAll.reduce((s,r)=>s+r.qty,0);
      const terms = khoSearchEl ? khoSearchEl.value.trim().toLowerCase().split(/\s+/).filter(Boolean) : [];
      if(terms.length){
        rowsAll = rowsAll.filter(r => {
          const hay = `${r.item} ${r.custpo} ${r.locator}`.toLowerCase();
          return terms.every(t => hay.includes(t));
        });
      }
    }

    // Chỉ toggle class hiện Plan cho tab Tìm mã hàng, không toggle ở tab Kiểm tồn kho
    if (khoTable && ids.table !== 'kt-detail-table') {
      PLAN_TYPES.forEach(type => {
        const loaded = !!planData[type];
        khoTable.classList.toggle(`show-plan-${type.toLowerCase()}`, loaded);
      });
    }

    // Vẫn tính toán plan cho rowsAll để dùng trong tab Tìm mã hàng nếu cần
    PLAN_TYPES.forEach(type => {
      const p = planData[type];
      rowsAll.forEach(r => {
        r['plan' + type] = p ? (Object.prototype.hasOwnProperty.call(p.byItem, r.item.toLowerCase()) ? p.byItem[r.item.toLowerCase()] : -1) : -1;
      });
    });

    khoRowsForFilterValues = rowsAll;
    if(enableColFilters) rowsAll = applyColFilters(khoColFilters, rowsAll, (r,c) => r[c]);
    updateFilterIcons(khoTable, khoColFilters);
    const khoClearBtn = document.getElementById(ids.khoClearFilters);
    if(khoClearBtn) khoClearBtn.style.display = anyColFilterActive(khoColFilters) ? 'inline' : 'none';

    let rows = [...rowsAll].sort((a,b) => {
      let va = a[sortKey], vb = b[sortKey];
      if(sortKey === 'qty' || String(sortKey || '').startsWith('plan')) return (va - vb) * sortDir;
      return String(va).localeCompare(String(vb)) * sortDir;
    });

    if(khoSummaryEl){
      if(multiMode){
        const matchedCodesCount = multiCodes.filter(g => rows.some(r => {
          const hay = multiHayMap.get(r);
          return g.every(tok => hay.includes(tok));
        })).length;
        khoSummaryEl.innerHTML = `<b>${fmt(rows.reduce((s,r)=>s+r.qty,0))}</b> Pcs &nbsp;·&nbsp; ${rows.length} dòng &nbsp;·&nbsp; khớp ${matchedCodesCount}/${multiCodes.length} mã tìm`;
      } else {
        khoSummaryEl.innerHTML = `<b>${fmt(rows.reduce((s,r)=>s+r.qty,0))}</b> / ${fmt(totalQty)} Pcs &nbsp;·&nbsp; ${rows.length} dòng`;
      }
    }

    if(!rows.length){
      if(khoTbody) khoTbody.innerHTML = '';
      if(khoEmptyEl){ khoEmptyEl.style.display = 'block'; khoEmptyEl.textContent = multiMode ? 'Không tìm thấy mã hàng nào khớp ở cả 4 kho' : 'Không có dòng nào khớp tìm kiếm'; }
      renderRawTable();
      return;
    }
    if(khoEmptyEl) khoEmptyEl.style.display = 'none';

    const planCell = (type, r) => {
      const v = r['plan' + type];
      return `<td class="col-plan col-plan-${type.toLowerCase()} num">${v === -1 ? '—' : fmt(v)}</td>`;
    };

    if(khoTbody){
      const isKiemTon = ids.table === 'kt-detail-table';
      const locatorColorMap = new Map();
      let lastLocatorGroup = null;
      // Danh sách locator đang có trong bảng kiểm kê hiện tại — dùng cho ô xổ xuống Locator của các
      // dòng "sai vị trí" được tự thêm khi quét QR (isScannedExtra), để có thể chọn lại nếu cần.
      const allLocatorsInTable = isKiemTon ? [...new Set(rowsAll.map(x => x.locator).filter(Boolean))].sort() : [];
      khoTbody.innerHTML = rows.map(r => {
        // Tạo key duy nhất cho dòng để kiểm tra đã xác nhận chưa
        const rowKey = r.item + '|' + r.custpo + '|' + r.locator + '|' + r.oqc + '|' + r.qty;

        // Nhóm màu theo Locator (chỉ áp dụng cho tab Kiểm tồn kho) — cùng vị trí = cùng màu nền,
        // giúp dễ nhìn khi kiểm lần lượt theo từng khu vực, giống cách nhóm theo Cont ở bảng Plan.
        let rowStyle = '', groupCls = '', locBorderStyle = '';
        if(isKiemTon){
          const locKey = r.locator || '—';
          const isNewGroup = locKey !== lastLocatorGroup;
          lastLocatorGroup = locKey;
          if(!locatorColorMap.has(locKey)) locatorColorMap.set(locKey, GROUP_COLOR_PALETTE[locatorColorMap.size % GROUP_COLOR_PALETTE.length]);
          const locColor = locatorColorMap.get(locKey);
          rowStyle = ` style="background:${hexToRgba(locColor, 0.07)};"`;
          groupCls = isNewGroup ? ' row-group-first' : '';
          locBorderStyle = ` style="border-left-color:${locColor};"`;
        }

        let extraCols = '';
        if (isKiemTon) {
          // Tab Kiểm tồn kho: Kết quả đưa lên đầu, thêm nút xác nhận cuối cùng
          // Kiểm tra xem dòng này đã nằm trong danh sách xác nhận chưa (để loại bỏ)
          if (confirmedKiemTonItems[rowKey]) {
            return ''; // Không render dòng đã xác nhận vào bảng chính nữa
          }
          // Khôi phục lại các giá trị đã nhập trước đó cho dòng này (nếu có), để không bị mất
          // số liệu khi bảng render lại do người dùng xác nhận 1 dòng khác.
          const ktSaved = ktInputValues[rowKey];
          const ktIv0 = ktSaved && ktSaved[0] !== undefined ? ktSaved[0] : 0;
          const ktIv1 = ktSaved && ktSaved[1] !== undefined ? ktSaved[1] : 1;
          const ktIv2 = ktSaved && ktSaved[2] !== undefined ? ktSaved[2] : 0;
          const ktIv3 = ktSaved && ktSaved[3] !== undefined ? ktSaved[3] : 1;
          const ktIv4 = ktSaved && ktSaved[4] !== undefined ? ktSaved[4] : 0;
          const ktIv5 = ktSaved && ktSaved[5] !== undefined ? ktSaved[5] : 1;
          extraCols = `
            <td class="kt-calc-cell">
              <div class="kt-calc-row">
                <span style="color:var(--text); font-weight:700; margin-right:4px;">KT =</span>
                <span class="kt-result" style="font-weight:700; color:${ktResultColor(ktIv0*ktIv1 + ktIv2*ktIv3 + ktIv4*ktIv5, r.qty)}; min-width:40px; text-align:right; display:inline-block;">${fmt(ktIv0*ktIv1 + ktIv2*ktIv3 + ktIv4*ktIv5)}</span>
                <button type="button" class="kt-calc-toggle"><span>Nhập số liệu</span><span class="kt-calc-toggle-arrow">▾</span></button>
                <span class="kt-calc-inputs">
                  <span style="margin: 0 4px; color:var(--muted-2);">|</span>
                  <span style="color:var(--muted-2);">(</span>
                  <input type="number" class="kt-input" value="${ktIv0}" data-default="0" style="width:35px; padding:2px; border:1px solid var(--line); border-radius:3px; text-align:center; font-size:11px; box-sizing:border-box;">
                  <span style="color:var(--muted-2);">×</span>
                  <input type="number" class="kt-input" value="${ktIv1}" data-default="1" style="width:35px; padding:2px; border:1px solid var(--line); border-radius:3px; text-align:center; font-size:11px; box-sizing:border-box;">
                  <span style="color:var(--muted-2);">) + (</span>
                  <input type="number" class="kt-input" value="${ktIv2}" data-default="0" style="width:35px; padding:2px; border:1px solid var(--line); border-radius:3px; text-align:center; font-size:11px; box-sizing:border-box;">
                  <span style="color:var(--muted-2);">×</span>
                  <input type="number" class="kt-input" value="${ktIv3}" data-default="1" style="width:35px; padding:2px; border:1px solid var(--line); border-radius:3px; text-align:center; font-size:11px; box-sizing:border-box;">
                  <span style="color:var(--muted-2);">) + (</span>
                  <input type="number" class="kt-input" value="${ktIv4}" data-default="0" style="width:35px; padding:2px; border:1px solid var(--line); border-radius:3px; text-align:center; font-size:11px; box-sizing:border-box;">
                  <span style="color:var(--muted-2);">×</span>
                  <input type="number" class="kt-input" value="${ktIv5}" data-default="1" style="width:35px; padding:2px; border:1px solid var(--line); border-radius:3px; text-align:center; font-size:11px; box-sizing:border-box;">
                  <span style="color:var(--muted-2);">)</span>
                </span>
                <button class="kt-confirm-btn" style="margin-left:8px; padding:2px 10px; border-radius:4px; border:1px solid var(--teal); background:var(--teal); color:white; font-size:11px; cursor:pointer; transition:all 0.2s; white-space:nowrap;" data-locked="false">Xác nhận</button>
              </div>
            </td>`;
        } else {
          // Tab Tìm mã hàng: giữ nguyên 3 cột Plan
          extraCols = PLAN_TYPES.map(type => planCell(type, r)).join('');
        }
        return `
        <tr class="${groupCls.trim()}${r.isScannedExtra ? ' row-scanned-extra' : ''}"${rowStyle}>
          <td class="col-kho" data-label="Kho">${r.kho.replace('Kho ','')}</td>
          <td data-label="Item No.">${r.item}${r.isScannedExtra ? ' <span class="scanned-extra-badge" title="Được tự thêm khi quét QR — mã này không có sẵn trong danh sách kiểm tại vị trí hệ thống ghi nhận">⚠ Sai vị trí</span>' : ''}</td>
          <td data-label="Cust PO">${r.custpo}</td>
          <td class="${isKiemTon ? 'loc-group-cell' : ''}" data-label="Locator"${isKiemTon ? locBorderStyle : ''}>${
            r.isScannedExtra
              ? `<select class="scanned-extra-loc-select">${allLocatorsInTable.map(loc => `<option value="${escAttr(loc)}"${loc === r.locator ? ' selected' : ''}>${escHtml(loc)}</option>`).join('')}</select>`
              : escHtml(r.locator)
          }</td>
          <td data-label="OQC">${oqcBadge(r.oqc)}</td>
          <td class="num" data-label="SL tồn">${fmt(r.qty)}</td>
          ${extraCols}
        </tr>`;
      }).join('');
    }
    renderRawTable();
    renderConfirmedList(); // Cập nhật danh sách đã xác nhận sau khi render bảng chính
  }

  function renderKhoSearchPage(){
    if(!currentData) return;
    const order = currentData.kho_order || Object.keys(currentData.kho_detail || {});
    if(order.length && khoTabsEl){
      activeKho = order.includes(activeKho) ? activeKho : order[0];
      khoTabsEl.innerHTML = order.map(k => {
        const cnt = (currentData.kho_detail[k] || []).length;
        return `<button class="kho-tab ${k===activeKho?'active':''}" data-kho="${k}">${k} <span class="cnt">(${cnt})</span></button>`;
      }).join('');
    }
    renderKhoTable();
  }

  if(khoTabsEl){
    khoTabsEl.addEventListener('click', (e) => {
      const btn = e.target.closest('.kho-tab');
      if(!btn || btn.classList.contains('disabled')) return;
      activeKho = btn.dataset.kho;
      [...khoTabsEl.children].forEach(c => c.classList.toggle('active', c === btn));
      if(khoSearchEl) khoSearchEl.value = '';
      renderKhoTable();
    });
  }

  if(khoSearchEl) khoSearchEl.addEventListener('input', debounce(renderKhoTable, 150));
  if(khoMultiSearchEl){
    khoMultiSearchEl.addEventListener('input', () => {
      khoMultiSearchEl.classList.toggle('active', khoMultiSearchEl.value.trim().length > 0);
      renderKhoTable();
    });
  }
  if(btnClearMulti){
    btnClearMulti.addEventListener('click', () => {
      if(khoMultiSearchEl){ khoMultiSearchEl.value = ''; khoMultiSearchEl.classList.remove('active'); }
      renderKhoTable();
      if(khoMultiSearchEl) khoMultiSearchEl.focus();
    });
  }

  if(khoTable){
    khoTable.querySelectorAll('thead th').forEach(th => {
      th.addEventListener('click', (e) => {
        if(e.target.closest('.th-filter-btn')) return;
        const key = th.dataset.key;
        if(sortKey === key) sortDir *= -1;
        else { sortKey = key; sortDir = (key === 'qty' || String(key || '').startsWith('plan')) ? -1 : 1; }
        renderKhoTable();
      });
    });
    addFilterButtonsToHeaders(khoTable, 'kho', KHO_FILTER_COLS);
  }
  if(rawTableEl){
    rawTableEl.querySelectorAll('thead th').forEach(th => {
      th.addEventListener('click', (e) => {
        if(e.target.closest('.th-filter-btn')) return;
        const idx = RAW_KEY_IDX[th.dataset.key];
        if(idx === undefined) return;
        if(rawSortIdx === idx) rawSortDir *= -1;
        else { rawSortIdx = idx; rawSortDir = (idx === 5) ? -1 : 1; }
        renderRawTable();
      });
    });
    addFilterButtonsToHeaders(rawTableEl, 'raw', RAW_FILTER_COLS);
  }
  if(enableColFilters){
    const khoClearBtn = document.getElementById(ids.khoClearFilters);
    if(khoClearBtn) khoClearBtn.addEventListener('click', () => {
      Object.keys(khoColFilters).forEach(k => delete khoColFilters[k]);
      renderKhoTable();
    });
    const rawClearBtn = document.getElementById(ids.rawClearFilters);
    if(rawClearBtn) rawClearBtn.addEventListener('click', () => {
      Object.keys(rawColFilters).forEach(k => delete rawColFilters[k]);
      renderRawTable();
    });
  }
  if(ids.rawExportBtn){
    const exportBtn = document.getElementById(ids.rawExportBtn);
    if(exportBtn) exportBtn.addEventListener('click', () => exportRawTableToExcel());
  }

  return { renderKhoSearchPage, focus: () => { if(khoSearchEl) khoSearchEl.focus(); } };
}

const searchCtrlMain = createSearchController({
  tabs:'kho-tabs', search:'kho-search', multiSearch:'kho-multi-search', clearBtn:'btn-clear-multi',
  summary:'kho-summary', table:'kho-detail-table', tbody:'kho-detail-tbody', empty:'kho-empty',
  rawTable:'raw-detail-table', rawTbody:'raw-detail-tbody', rawEmpty:'raw-empty', rawSummary:'raw-summary',
  enableColumnFilters: true, khoClearFilters:'kho-clear-col-filters', rawClearFilters:'raw-clear-col-filters',
  rawExportBtn:'raw-export-excel'
});

const searchCtrlKiemTon = createSearchController({
  tabs:'kt-tabs', search:'kt-search', multiSearch:'kt-multi-search', clearBtn:'kt-clear-multi',
  summary:'kt-summary', table:'kt-detail-table', tbody:'kt-detail-tbody', empty:'kt-empty'
});

/* ============ Quét mã vạch/QR (camera điện thoại) để nhập nhanh khi kiểm tồn kho ============
   Mã QR/vạch in trên tem mỗi pallet chỉ chứa đúng 1 nội dung: GI No. — nên khi quét được, phải tra
   GI No. đó trong dữ liệu gốc (raw_rows) ra đúng Item/Cust PO/Locator/Kho/SL của pallet đó.
   LOGIC PHÁT HIỆN SAI VỊ TRÍ: người quét đi lần lượt từng vị trí thực tế ngoài kho. Lượt quét ĐẦU
   TIÊN trong phiên (hoặc sau khi bấm "Đổi vị trí") xác lập vị trí đang đứng quét (qrScanPhysicalLocator).
   Các lượt quét kế tiếp: nếu Locator hệ thống ghi nhận của pallet KHÁC với vị trí đang đứng quét ->
   hiểu là pallet đó đang bị đặt SAI VỊ TRÍ ngoài thực tế (vật lý đang nằm ở vị trí đang quét, không
   phải vị trí hệ thống ghi) — dòng được ghi nhận vào ĐÚNG vị trí thực tế đang quét, không phải vị trí
   hệ thống. Khi người quét di chuyển sang vị trí khác, cần bấm "📍 Đổi vị trí" để xác lập lại mốc,
   nếu không mọi pallet ở vị trí mới sẽ bị hiểu nhầm là sai vị trí hết. Chế độ quét liên tục: quét
   xong 1 mã thì tự động tiếp tục quét mã tiếp theo, chỉ dừng khi bấm nút "Thoát". */
let qrScanStream = null;
let qrScanRAF = null;
let qrScanCount = 0;
let qrScanLastCode = null;
let qrScanPhysicalLocator = null; // vị trí thực tế đang đứng quét trong phiên hiện tại — null = chưa xác lập
// Khoá mã hàng: khi bật (qrScanItemLockEnabled), mã hàng của LƯỢT QUÉT TIẾP THEO sẽ được ghi vào
// qrScanLockedItem — từ đó mọi lượt quét ra mã KHÁC mã đã khoá đều bị BỎ QUA (không tính, không cộng
// vào bảng), dùng khi đang đếm riêng đúng 1 mã hàng, tránh lỡ tay quét lẫn pallet của mã khác vào.
let qrScanItemLockEnabled = false;
let qrScanLockedItem = null; // null = đã bật khoá nhưng CHƯA quét lượt nào để xác lập mã bị khoá
// null = tin tưởng hoàn toàn OQC hệ thống ghi cho từng pallet (mặc định, không làm chậm quét hàng
// loạt). Khi người quét CHỌN 1 trạng thái cụ thể (PASS/NG/Khac), mọi lượt quét sau đó sẽ dùng ĐÚNG
// giá trị này thay vì tin OQC hệ thống — dùng khi biết trước cả cụm pallet đang cầm trên tay thực tế
// là OQC gì (VD: vừa IQC xong, tem tồn kho chưa kịp cập nhật) — nếu khác OQC hệ thống sẽ báo "Sai OQC"
// và KHÔNG cộng nhầm vào dòng OQC khác, tránh 2 dòng PASS/NG bù trừ số lượng cho nhau.
let qrScanOqcOverride = null;
let qrBarcodeDetector = null; // null = dùng jsQR (dự phòng); có giá trị = dùng bộ nhận diện của máy
let qrScanNativeBusy = false; // chặn không cho 2 lượt detect() (bất đồng bộ) chạy chồng lên nhau

function qrScanAddLog(text, cls){
  const log = document.getElementById('qr-scan-log');
  if(!log) return;
  const div = document.createElement('div');
  div.className = 'qr-scan-log-item' + (cls ? ' ' + cls : '');
  div.textContent = text;
  log.prepend(div);
  while(log.children.length > 30) log.removeChild(log.lastChild);
}
function qrScanSetStatus(text, cls){
  const el = document.getElementById('qr-scan-status');
  if(!el) return;
  el.textContent = text;
  el.className = 'qr-scan-status' + (cls ? ' ' + cls : '');
}
function qrScanUpdateCounter(){
  const el = document.getElementById('qr-scan-counter');
  if(el) el.textContent = `Đã quét: ${qrScanCount} pallet`;
}
function qrScanUpdateLocatorBadge(){
  const el = document.getElementById('qr-scan-locator-badge');
  if(!el) return;
  el.textContent = qrScanPhysicalLocator ? `📍 Đang quét tại: ${qrScanPhysicalLocator}` : '📍 Chưa xác lập vị trí — quét 1 mã bất kỳ để bắt đầu';
}
function qrScanResetLocator(){
  qrScanPhysicalLocator = null;
  qrScanUpdateLocatorBadge();
  qrScanSetStatus('Đã đổi vị trí — quét pallet đầu tiên tại vị trí mới để xác lập lại mốc.', '');
}
function qrScanUpdateItemLockBadge(){
  const el = document.getElementById('qr-scan-item-lock-badge');
  const btn = document.getElementById('qr-scan-item-lock-btn');
  if(el){
    el.textContent = !qrScanItemLockEnabled
      ? '🔓 Chưa khoá mã — quét lẫn nhiều mã hàng vẫn tính bình thường'
      : (qrScanLockedItem
        ? `🔒 Đang khoá mã: ${qrScanLockedItem} — mã khác sẽ bị bỏ qua`
        : '🔒 Đã bật khoá — mã của lượt quét TIẾP THEO sẽ được khoá lại');
  }
  if(btn) btn.textContent = qrScanItemLockEnabled ? '🔓 Bỏ khoá' : '🔒 Khoá mã';
}
function qrScanToggleItemLock(){
  qrScanItemLockEnabled = !qrScanItemLockEnabled;
  qrScanLockedItem = null;
  qrScanUpdateItemLockBadge();
  qrScanSetStatus(
    qrScanItemLockEnabled
      ? 'Đã bật khoá mã — quét 1 pallet bất kỳ để xác lập mã cần khoá, các mã khác sau đó sẽ bị bỏ qua.'
      : 'Đã tắt khoá mã — quét lẫn mã hàng nào cũng được tính bình thường.',
    ''
  );
}
function qrScanUpdateOqcBtns(){
  const wrap = document.getElementById('qr-scan-oqc-btns');
  if(!wrap) return;
  wrap.querySelectorAll('.qr-scan-oqc-btn').forEach(btn => {
    const val = btn.dataset.oqc || null;
    btn.classList.toggle('active', val === qrScanOqcOverride);
  });
}

async function openQrScanOverlay(){
  const overlay = document.getElementById('qr-scan-overlay');
  const video = document.getElementById('qr-scan-video');
  if(!overlay || !video) return;
  if(typeof jsQR === 'undefined'){
    alert('Không tải được thư viện quét mã (cần Internet). Vui lòng thử lại.');
    return;
  }
  // Khởi tạo/mở khoá AudioContext NGAY TRONG lúc bấm nút (thao tác chạm của người dùng) — trình
  // duyệt (đặc biệt Safari/iPhone) chặn phát âm thanh nếu không bắt nguồn trực tiếp từ 1 cú chạm,
  // nên phải làm bước này ở đây thay vì đợi tới lúc quét được mã (khi đó không còn tính là thao
  // tác chạm nữa, âm thanh sẽ bị chặn im lặng không kêu).
  qrGetAudioCtx();
  // Camera (getUserMedia) chỉ hoạt động trên "secure context" — trang phải được mở qua địa chỉ
  // https:// thật (hoặc http://localhost). Mở trực tiếp file HTML từ máy (file:// hoặc
  // content://) sẽ luôn bị trình duyệt chặn, báo "Permission denied" dù đã cấp quyền Camera cho
  // app — không phải do thiếu quyền, không có cách nào sửa bằng code để vượt qua giới hạn bảo mật
  // này. Kiểm tra trước để báo đúng nguyên nhân, tránh gây hiểu lầm là do quyền Camera.
  if(!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){
    alert('Không thể dùng Camera vì trang đang được mở trực tiếp từ file trên máy (không phải qua địa chỉ https://). Đây là giới hạn bảo mật của trình duyệt, không phải do thiếu quyền Camera. Cần tải file này lên 1 nơi lưu trữ có https:// (VD: GitHub Pages, Netlify, Google Sites…) rồi mở bằng đường link đó thì Camera mới dùng được.');
    return;
  }
  try{
    // Yêu cầu độ phân giải CAO (thay vì để trình duyệt tự chọn mặc định, thường chỉ ~640x480) và bật
    // lấy nét liên tục nếu máy hỗ trợ — mã QR càng dày/nhiều chi tiết càng cần độ phân giải cao mới
    // đọc được rõ từng ô vuông nhỏ, ảnh mờ/độ phân giải thấp là nguyên nhân phổ biến nhất khiến quét
    // "không nhận" dù mã vẫn nằm rõ ràng trong khung hình. Dùng "ideal" (không phải "exact") nên máy
    // không hỗ trợ vẫn chạy bình thường, chỉ là lấy độ phân giải gần nhất có thể.
    qrScanStream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: 'environment',
        width: { ideal: 1920 },
        height: { ideal: 1080 },
        advanced: [{ focusMode: 'continuous' }]
      }
    });
  }catch(err){
    alert('Không mở được camera: ' + (err && err.message ? err.message : 'không rõ lỗi') + '. Hãy kiểm tra đã cấp quyền Camera cho trình duyệt/app chưa.');
    return;
  }
  video.srcObject = qrScanStream;
  overlay.style.display = 'flex';
  qrScanCount = 0;
  qrScanLastCode = null;
  qrScanPhysicalLocator = null;
  qrScanOqcOverride = null;
  // LƯU Ý: KHÔNG reset qrScanItemLockEnabled/qrScanLockedItem ở đây — khác với vị trí (mỗi lần mở lại
  // là 1 vị trí thực tế mới nên phải xác lập lại), khoá mã hàng cần GIỮ NGUYÊN xuyên suốt nhiều lần
  // thoát/mở lại màn hình quét (VD: quét xong 1 locator, thoát ra xem hàng đang ở locator nào, rồi mở
  // lại quét tiếp CÙNG 1 mã đó) — chỉ tắt khi người dùng tự bấm "Bỏ khoá".
  qrScanUpdateCounter();
  qrScanUpdateLocatorBadge();
  qrScanUpdateOqcBtns();
  qrScanUpdateItemLockBadge();
  qrScanSetStatus('Đưa mã vạch/QR (tem pallet) vào khung để quét…', '');
  const log = document.getElementById('qr-scan-log');
  if(log) log.innerHTML = '';
  // "Mồi" + kiểm tra rung/âm thanh NGAY lúc mở camera (còn trong thao tác chạm, dễ được trình duyệt
  // cho phép nhất) — ghi thẳng KẾT QUẢ THẬT vào nhật ký quét để biết chính xác máy này có hỗ trợ/cho
  // phép hay không, thay vì đoán mò khi người dùng báo "không rung, không nghe thấy gì".
  if(!navigator.vibrate){
    qrScanAddLog('⚠ Máy/trình duyệt này KHÔNG có API rung (navigator.vibrate không tồn tại) — sẽ không rung được, chỉ còn tiếng bíp.', 'warn');
  } else {
    try{
      const okVibrate = navigator.vibrate(35);
      qrScanAddLog(okVibrate
        ? '✓ Đã gửi lệnh rung mồi — nếu KHÔNG cảm nhận được rung, kiểm tra máy có đang tắt rung/ở chế độ im lặng không.'
        : '⚠ navigator.vibrate() từ chối rung (trả về false) — có thể do cài đặt hệ thống chặn.', okVibrate ? 'ok' : 'warn');
    }catch(e){
      qrScanAddLog('⚠ Lỗi khi gọi rung: ' + e.message, 'warn');
    }
  }
  try{
    qrBeepSuccess();
    qrScanAddLog('✓ Đã phát tiếng bíp mồi — nếu KHÔNG nghe thấy, kiểm tra âm lượng media (không phải âm lượng chuông) của máy.', 'ok');
  }catch(e){
    qrScanAddLog('⚠ Lỗi khi phát âm thanh: ' + e.message, 'warn');
  }
  // Ưu tiên dùng bộ nhận diện mã vạch CÓ SẴN CỦA HỆ ĐIỀU HÀNH (BarcodeDetector — trên Android chạy
  // bằng chính công cụ Google ML Kit tích hợp sẵn) nếu trình duyệt hỗ trợ — nhận diện chính xác và
  // nhanh hơn NHIỀU so với tự giải mã bằng JavaScript thuần (jsQR), đặc biệt với mã QR dày/nhiều chi
  // tiết hoặc ảnh không hoàn hảo. jsQR chỉ dùng làm phương án dự phòng cho trình duyệt không hỗ trợ
  // (VD: Safari/iPhone hiện chưa hỗ trợ BarcodeDetector).
  qrBarcodeDetector = null;
  if('BarcodeDetector' in window){
    try{
      qrBarcodeDetector = new BarcodeDetector({ formats: ['qr_code'] });
      qrScanAddLog('✓ Dùng bộ nhận diện mã vạch có sẵn của máy (nhanh & chính xác hơn) để quét.', 'ok');
    }catch(e){
      qrBarcodeDetector = null;
      qrScanAddLog('⚠ Máy có API nhận diện mã vạch nhưng khởi tạo lỗi (' + e.message + ') — dùng phương án dự phòng jsQR.', 'warn');
    }
  } else {
    qrScanAddLog('ℹ Trình duyệt này chưa hỗ trợ bộ nhận diện mã vạch có sẵn — dùng phương án dự phòng jsQR (yếu hơn với mã dày/ảnh không hoàn hảo).', '');
  }
  if(qrBarcodeDetector) qrScanTickNative();
  else qrScanTick();
}

function closeQrScanOverlay(){
  const overlay = document.getElementById('qr-scan-overlay');
  if(overlay) overlay.style.display = 'none';
  if(qrScanRAF) cancelAnimationFrame(qrScanRAF);
  qrScanRAF = null;
  if(qrScanStream){
    qrScanStream.getTracks().forEach(t => t.stop());
    qrScanStream = null;
  }
  if(qrAudioCtx && qrAudioCtx.state === 'running') qrAudioCtx.suspend().catch(() => {});
}

// Vòng quét dùng BarcodeDetector CÓ SẴN CỦA MÁY (nhanh/chính xác hơn jsQR nhiều) — nhận thẳng
// <video> làm đầu vào (không cần tự vẽ ra canvas để giải mã như jsQR), trình duyệt tự lo phần đọc
// khung hình camera hiệu quả nhất.
async function qrScanTickNative(){
  const video = document.getElementById('qr-scan-video');
  if(!video || !qrScanStream){ return; }
  if(video.readyState !== video.HAVE_ENOUGH_DATA || qrScanNativeBusy){
    qrScanRAF = requestAnimationFrame(qrScanTickNative);
    return;
  }
  qrScanNativeBusy = true;
  try{
    const barcodes = await qrBarcodeDetector.detect(video);
    if(barcodes && barcodes.length && barcodes[0].rawValue){
      const data = barcodes[0].rawValue;
      // Chỉ xử lý 1 mã ĐÚNG 1 LẦN trong khi nó còn nằm liên tục trong khung hình (xem giải thích ở
      // qrScanTick bên dưới — áp dụng y hệt).
      if(data !== qrScanLastCode){
        qrScanLastCode = data;
        handleQrScanResult(data.trim());
      }
    } else {
      qrScanLastCode = null;
    }
  }catch(err){ /* bỏ qua lỗi đọc frame lẻ tẻ, thử lại frame sau */ }
  qrScanNativeBusy = false;
  qrScanRAF = requestAnimationFrame(qrScanTickNative);
}

function qrScanTick(){
  const video = document.getElementById('qr-scan-video');
  const canvas = document.getElementById('qr-scan-canvas');
  if(!video || !canvas){ return; }
  if(video.readyState !== video.HAVE_ENOUGH_DATA){
    qrScanRAF = requestAnimationFrame(qrScanTick);
    return;
  }
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  let code = null;
  try{
    // Ưu tiên giải mã đúng VÙNG BÊN TRONG khung xanh hiện trên màn hình (khớp CSS .qr-scan-frame,
    // inset 12% mỗi cạnh) — vừa loại bỏ nền xung quanh gây rối cho thuật toán tìm mã, vừa coi như
    // "phóng to" mã QR tương đối so với vùng ảnh đưa vào giải mã, giúp đọc được cả những mã dày/nhiều
    // chi tiết mà quét trên nguyên khung hình đầy đủ có thể bị bỏ sót vì độ phân giải camera không đủ.
    const marginX = Math.round(canvas.width * 0.12);
    const marginY = Math.round(canvas.height * 0.12);
    const cropW = canvas.width - marginX * 2;
    const cropH = canvas.height - marginY * 2;
    if(cropW > 0 && cropH > 0){
      const croppedData = ctx.getImageData(marginX, marginY, cropW, cropH);
      code = jsQR(croppedData.data, croppedData.width, croppedData.height);
    }
    // Không thấy trong vùng khung -> thử lại trên TOÀN khung hình, phòng khi mã bị lệch ra ngoài
    // khung xanh 1 chút nhưng vẫn còn lọt trong camera.
    if(!code || !code.data){
      const fullData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      code = jsQR(fullData.data, fullData.width, fullData.height);
    }
  }catch(err){ /* bỏ qua lỗi đọc frame lẻ tẻ, thử lại frame sau */ }
  if(code && code.data){
    // Chỉ xử lý 1 mã QR ĐÚNG 1 LẦN trong khi nó còn nằm liên tục trong khung hình — không đọc lại
    // mỗi vài giây nữa (trước đây cứ 1.5s lại đọc lại, khiến báo "đã quét trước đó" lặp đi lặp lại
    // liên tục khi camera vẫn đang chĩa vào cùng 1 tem, gây hiểu lầm là quét lỗi/không quét được).
    if(code.data !== qrScanLastCode){
      qrScanLastCode = code.data;
      handleQrScanResult(code.data.trim());
    }
  } else {
    // Không còn thấy mã nào trong khung hình -> reset, để lần THẤY LẠI tiếp theo (kể cả gặp lại
    // đúng mã cũ, VD: camera rung lắc mất dấu rồi bắt lại) được coi là 1 lượt quét mới.
    qrScanLastCode = null;
  }
  qrScanRAF = requestAnimationFrame(qrScanTick);
}

// Phát tiếng "bíp" ngắn bằng Web Audio API (tự tạo sóng âm, không cần file .mp3/.wav nào) — dùng
// làm phản hồi ÂM THANH khi quét, quan trọng nhất cho iPhone/Safari vì API rung (navigator.vibrate)
// không tồn tại trên nền tảng đó — rung thôi sẽ hoàn toàn im lặng, không báo được gì cho người dùng.
let qrAudioCtx = null;
function qrGetAudioCtx(){
  if(!qrAudioCtx){
    try{ qrAudioCtx = new (window.AudioContext || window.webkitAudioContext)(); }catch(e){ qrAudioCtx = null; }
  }
  if(qrAudioCtx && qrAudioCtx.state === 'suspended') qrAudioCtx.resume().catch(() => {});
  return qrAudioCtx;
}
function qrPlayBeepPattern(notes){
  const ctx = qrGetAudioCtx();
  if(!ctx) return;
  let t = ctx.currentTime;
  notes.forEach(n => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(n.freq, t);
    // Lên/xuống âm lượng nhanh ở đầu/cuối mỗi tiếng bíp để tránh tiếng "tách" khó chịu khi bật/tắt đột ngột.
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(0.35, t + 0.01);
    gain.gain.linearRampToValueAtTime(0, t + n.dur);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + n.dur + 0.02);
    t += n.dur + (n.gap || 0);
  });
}
// 3 kiểu tiếng bíp khác nhau rõ rệt, khớp đúng với 3 kiểu rung — nghe là phân biệt được ngay:
// 1 tiếng bíp cao ngắn = thành công; 2 tiếng bíp liên tiếp = có cảnh báo; 1 tiếng bíp trầm dài = bị từ chối.
function qrBeepSuccess(){ qrPlayBeepPattern([{ freq: 1046, dur: 0.09 }]); }
function qrBeepWarn(){ qrPlayBeepPattern([{ freq: 740, dur: 0.08, gap: 0.05 }, { freq: 740, dur: 0.08 }]); }
function qrBeepError(){ qrPlayBeepPattern([{ freq: 220, dur: 0.28 }]); }

function handleQrScanResult(giNoRaw){
  // Mã QR thực tế quét được thường có thêm rất nhiều thông tin phía sau (nối bằng ký tự "^", VD:
  // "TN526090363725^W31_2026_025313024_2-PMC12+PORD130612^..."), nhưng số GI No. đúng chỉ là
  // 14 KÝ TỰ ĐẦU TIÊN — luôn cắt về đúng 14 ký tự trước khi tra cứu/so khớp/hiện log, để không bị
  // báo "Không tìm thấy GI No." do dính theo phần thừa phía sau.
  const giNo = String(giNoRaw || '').trim().slice(0, 14);
  const result = handleQrScanReal(giNo);
  qrScanCount++;
  qrScanUpdateCounter();
  // Rung + phát tiếng bíp phản hồi NGAY khi quét — 3 kiểu khác nhau rõ rệt cho 3 kết quả, để không
  // cần nhìn màn hình vẫn biết ngay quét đúng hay có vấn đề. Có cả 2 kênh (rung + âm thanh) vì rung
  // không hoạt động trên iPhone/Safari — âm thanh đảm bảo vẫn có phản hồi trên mọi thiết bị.
  try{
    if(navigator.vibrate){
      if(!result.ok) navigator.vibrate(250);
      else if(result.mismatch) navigator.vibrate([60, 80, 60]);
      else navigator.vibrate(60);
    }
  }catch(e){ /* im lặng bỏ qua — đã có dòng chẩn đoán rung riêng lúc mở camera */ }
  try{
    if(!result.ok) qrBeepError();
    else if(result.mismatch) qrBeepWarn();
    else qrBeepSuccess();
  }catch(e){ qrScanAddLog('⚠ Lỗi phát âm thanh: ' + e.message, 'warn'); }
  if(!result.ok){
    qrScanSetStatus('✗ ' + result.message, 'err');
    qrScanAddLog('✗ ' + giNo + ' — ' + result.message, 'err');
  } else if(result.mismatch){
    qrScanSetStatus('⚠ ' + result.message, 'warn');
    qrScanAddLog('⚠ ' + giNo + ' — ' + result.message, 'warn');
  } else {
    qrScanSetStatus(result.message, 'ok');
    qrScanAddLog('✓ ' + giNo + ' — ' + result.message, 'ok');
  }
}

// Xử lý 1 lượt quét QR (nội dung quét được chính là GI No. in trên tem pallet) — áp dụng trực tiếp
// vào danh sách "Đề xuất kiểm hôm nay" (ccKhoResults) đang hiển thị trên trang Kiểm tồn kho, vì đây
// mới là bảng THẬT đang hiện trên màn hình (không phải bảng tìm kiếm kho_detail).
function handleQrScanReal(giNoRaw){
  const giNo = String(giNoRaw || '').trim();
  if(!giNo) return { ok:false, message:'Mã quét được trống.' };
  if(!currentData) return { ok:false, message:'Chưa có dữ liệu tồn kho.' };

  const norm = giNo.toLowerCase();
  if(scannedGiSet.has(norm)) return { ok:false, duplicate:true, message:`GI No. "${giNo}" đã được quét trước đó — không quét trùng.` };

  const rawRows = getRawRows(currentData);
  const match = rawRows.find(r => String(r[RAW_KEY_IDX.gi] || '').trim().toLowerCase() === norm);
  if(!match) return { ok:false, message:`Không tìm thấy GI No. "${giNo}" trong tồn kho hiện tại.` };

  const kho = match[RAW_KEY_IDX.kho];
  const item = match[RAW_KEY_IDX.item];
  const custpo = String(match[RAW_KEY_IDX.custpo] || '').trim();
  const systemLocator = match[RAW_KEY_IDX.locator];
  const oqcRaw = String(match[RAW_KEY_IDX.oqc] || '').trim();
  const systemOqcNorm = ccOqcNormalize(oqcRaw);
  const palletQty = Number(match[RAW_KEY_IDX.qty]) || 0;
  const khoObj = CC_KHO_LIST.find(k => k.label === kho);

  // Đang bật "Khoá mã": lượt quét ĐẦU TIÊN sau khi bật xác lập mã bị khoá; các lượt quét sau đó nếu
  // ra mã hàng KHÁC mã đã khoá thì BỎ QUA HOÀN TOÀN (không cộng vào bảng, không đánh dấu đã quét — để
  // vẫn quét lại được bình thường nếu sau này tắt khoá hoặc khoá sang mã khác).
  if(qrScanItemLockEnabled){
    if(qrScanLockedItem === null){
      qrScanLockedItem = item;
      qrScanUpdateItemLockBadge();
    } else if(qrScanLockedItem !== item){
      return { ok:false, message:`🔒 Đang khoá mã ${qrScanLockedItem} — mã "${item}" quét được không khớp, đã BỎ QUA (không tính).` };
    }
  }

  // Lượt quét ĐẦU TIÊN trong phiên (hoặc sau khi bấm "Đổi vị trí") xác lập vị trí đang đứng quét.
  // Nếu Locator hệ thống của pallet KHÁC vị trí đang đứng quét -> pallet này đang bị đặt sai vị trí
  // ngoài thực tế; ghi nhận theo đúng vị trí THỰC TẾ đang quét, không phải vị trí hệ thống.
  if(qrScanPhysicalLocator === null){
    qrScanPhysicalLocator = systemLocator;
    qrScanUpdateLocatorBadge();
  }
  const isWrongLocation = systemLocator !== qrScanPhysicalLocator;
  const effectiveLocator = isWrongLocation ? qrScanPhysicalLocator : systemLocator;

  // Nếu người quét đã CHỌN 1 OQC cụ thể (khác "Theo hệ thống", xem qrScanOqcOverride) và khác với OQC
  // hệ thống ghi cho ĐÚNG pallet này -> coi là "Sai OQC", ghi nhận theo đúng OQC đã chọn — giống hệt
  // cơ chế Sai vị trí, KHÔNG BAO GIỜ cộng lẫn vào dòng OQC khác (tránh 2 dòng PASS/NG bù trừ nhau).
  const isWrongOqc = qrScanOqcOverride !== null && qrScanOqcOverride !== systemOqcNorm;
  const effectiveOqcNorm = isWrongOqc ? qrScanOqcOverride : systemOqcNorm;
  const effectiveOqcLabel = effectiveOqcNorm === 'Khac' ? 'Khác' : effectiveOqcNorm;
  const systemOqcLabel = systemOqcNorm === 'Khac' ? 'Khác' : systemOqcNorm;
  const isMismatch = isWrongLocation || isWrongOqc;

  // Kho này chưa "Tạo danh sách" lần nào -> tự khởi tạo 1 danh sách rỗng ở chế độ Locator để có chỗ
  // hiển thị dòng vừa quét được.
  if(!ccKhoResults[kho]){
    ccKhoResults[kho] = { mode:'locator', list: [] };
    ccKhoMode[kho] = 'locator';
  }
  const result = ccKhoResults[kho];
  const flatItems = result.mode === 'locator' ? result.list.flatMap(g => g.items) : result.list;
  const foundItem = flatItems.find(r =>
    r.item === item && String(r.custpo || '').trim() === custpo && r.locator === effectiveLocator && ccOqcNormalize(r.oqc) === effectiveOqcNorm
  );

  let response;
  let loggedRowKey = null;
  if(foundItem && !isMismatch){
    const rowKey = ccRowKeyForItem(foundItem);
    ktInputValues[rowKey] = mergePalletIntoKtTally(ktInputValues[rowKey], palletQty);
    loggedRowKey = rowKey;
    response = { ok:true, mismatch:false,
      message:`✓ ${item}${custpo ? ' (PO ' + custpo + ')' : ''} — ${effectiveLocator} — đã cộng ${fmt(palletQty)} Pcs vào ô kiểm thực tế.` };
  } else {
    // QUAN TRỌNG: các dòng "⚠ Sai vị trí/Sai OQC" KHÔNG được tự tăng SL tồn (existing.qty) theo số
    // lượng vừa quét — SL tồn của các dòng này LUÔN giữ = 0, vì hệ thống KHÔNG hề dự kiến có hàng ở
    // đúng vị trí/OQC này. Nhờ vậy các dòng này sẽ hiện đúng là "Dư" (SL kiểm > SL tồn = 0) trong mọi
    // bảng so sánh/báo cáo xuất ra — trước đây SL tồn tự tăng theo đúng số vừa quét làm 2 số luôn
    // bằng nhau, trông như "khớp đúng" nên KHÔNG hiện lên báo cáo dù thực chất đây là hàng phát hiện
    // thừa/sai vị trí cần chú ý. Riêng trường hợp "mã CHƯA CÓ trong danh sách" nhưng ĐÚNG vị trí+OQC
    // (không phải sai lệch gì, chỉ là chưa được chọn vào mẫu "Đề xuất kiểm hôm nay") thì lấy đúng SL
    // tồn THẬT từ dữ liệu gốc cho combo này, để so sánh chính xác thay vì mặc định 0.
    const addToList = (existing) => {
      const key = ccRowKeyForItem(existing);
      const tally = mergePalletIntoKtTally(ktInputValues[key], palletQty);
      existing.palletCount = (existing.palletCount || 0) + 1;
      ktInputValues[key] = tally;
      loggedRowKey = key;
    };
    const realQtyForCombo = isMismatch ? 0 : rawRows
      .filter(rr =>
        String(rr[RAW_KEY_IDX.item] || '').trim().toLowerCase() === item.toLowerCase() &&
        String(rr[RAW_KEY_IDX.custpo] || '').trim().toLowerCase() === custpo.toLowerCase() &&
        String(rr[RAW_KEY_IDX.locator] || '') === effectiveLocator &&
        ccOqcNormalize(rr[RAW_KEY_IDX.oqc]) === effectiveOqcNorm
      )
      .reduce((s, rr) => s + (Number(rr[RAW_KEY_IDX.qty]) || 0), 0);
    const newRowBase = {
      kho, item, custpo, locator: effectiveLocator, oqc: isWrongOqc ? effectiveOqcLabel : oqcRaw,
      qty: realQtyForCombo, palletCount: 0, isScannedExtra: isMismatch,
      isWrongLocation, wmsLocator: systemLocator,
      isWrongOqc, wmsOqc: oqcRaw
    };
    if(result.mode === 'locator'){
      let grp = result.list.find(g => g.locator === effectiveLocator);
      if(!grp){ grp = { locator: effectiveLocator, items: [], maxScore: 0, palletCount: 0 }; result.list.push(grp); }
      // Nếu đang SAI VỊ TRÍ/SAI OQC: CHỈ được cộng dồn vào 1 dòng "⚠" đã tự tạo từ lượt quét lệch
      // trước đó (r.isScannedExtra === true) — TUYỆT ĐỐI không được cộng nhầm vào 1 dòng BÌNH THƯỜNG
      // đã có sẵn trong kế hoạch (dù trùng y hệt mã hàng + PO + OQC hiệu lực), vì dòng đó là hàng ĐÚNG,
      // không liên quan gì tới pallet lệch này — trộn chung sẽ làm mất cảnh báo và làm 2 dòng OQC
      // khác nhau (VD: PASS/NG cùng 1 mã) bù trừ số lượng cho nhau.
      let existing = grp.items.find(r => r.item === item && String(r.custpo || '').trim() === custpo && ccOqcNormalize(r.oqc) === effectiveOqcNorm && (!isMismatch || r.isScannedExtra));
      if(!existing){ existing = newRowBase; grp.items.push(existing); }
      addToList(existing);
    } else {
      let existing = result.list.find(r => r.item === item && String(r.custpo || '').trim() === custpo && r.locator === effectiveLocator && ccOqcNormalize(r.oqc) === effectiveOqcNorm && (!isMismatch || r.isScannedExtra));
      if(!existing){ existing = newRowBase; result.list.push(existing); }
      addToList(existing);
    }
    if(isMismatch){
      const parts = [];
      if(isWrongLocation) parts.push(`vị trí hệ thống ghi ${systemLocator}, đang quét thấy tại ${effectiveLocator}`);
      if(isWrongOqc) parts.push(`OQC hệ thống ghi ${systemOqcLabel}, bạn xác nhận là ${effectiveOqcLabel}`);
      const tag = isWrongLocation && isWrongOqc ? 'SAI VỊ TRÍ & SAI OQC' : (isWrongLocation ? 'SAI VỊ TRÍ' : 'SAI OQC');
      response = { ok:true, mismatch:true,
        message:`⚠ ${tag} — hệ thống ghi nhận mã ${item}${custpo ? ' (PO ' + custpo + ')' : ''}: ${parts.join('; ')}. Đã ghi nhận đúng theo thực tế, KHÔNG cộng lẫn vào dòng khác.` };
    } else {
      response = { ok:true, mismatch:false,
        message:`✓ ${item}${custpo ? ' (PO ' + custpo + ')' : ''} — ${effectiveLocator} — mã chưa có trong danh sách, đã tự thêm và cộng ${fmt(palletQty)} Pcs.` };
    }
  }

  if(khoObj){
    if(result.mode === 'locator') ccRenderLocatorCards(khoObj.code, kho, result.list);
    else ccRenderKhoResult(khoObj.code, kho, result.mode, result.list);
    ccSetCardLocked(kho, true);
  }
  scannedGiSet.add(norm); // đánh dấu GI này đã xử lý xong — quét lại sẽ báo trùng, không cộng thêm nữa
  if(loggedRowKey){
    giScanLog.push({
      gi: norm, kho, item, custpo, locator: effectiveLocator,
      oqc: effectiveOqcNorm === 'Khac' ? 'Khác' : effectiveOqcNorm,
      qty: palletQty, rowKey: loggedRowKey, ts: new Date().toISOString()
    });
    // Giới hạn số dòng log tối đa — quét QR trong 1 đợt kiểm tồn có thể lên tới hàng nghìn lượt, cứ
    // cộng dồn mãi không giới hạn sẽ làm giScanLog (và JSON của nó mỗi lần lưu) phình to dần suốt cả
    // đợt kiểm. Giữ lại GIH_SCAN_LOG_MAX dòng GẦN NHẤT là đủ dùng cho "Xem GI đã quét" (mục đích chính
    // của log này), bỏ bớt các dòng cũ nhất khi vượt ngưỡng.
    if(giScanLog.length > GI_SCAN_LOG_MAX) giScanLog.splice(0, giScanLog.length - GI_SCAN_LOG_MAX);
  }
  saveStateToStorage();
  // Đẩy lên Cloud sau 2 giây (dùng riêng timerKey 'qrscan' — không dùng chung 'confirm' vì quét QR
  // diễn ra RẤT dồn dập, dùng chung sẽ liên tục reset debounce của "Xác nhận"). Nếu mất mạng/đóng tab
  // giữa lúc đang quét cả loạt pallet, trước đây MẤT TOÀN BỘ tiến độ chưa kịp bấm "Lưu" — đây là thao
  // tác lặp lại nhiều nhất khi kiểm tồn kho nên cần tự lưu, không thể để phụ thuộc vào nhớ bấm Lưu.
  // QUAN TRỌNG: PHẢI đẩy kèm STORAGE_KEY_KT_INPUTS — trước đây thiếu key này, nên mỗi lần quét QR chỉ
  // cập nhật ktInputValues (ô "Kiểm thực tế") CỤC BỘ, không đẩy lên Cloud. Cloud vẫn giữ bản KT_INPUTS
  // CŨ; nếu sau đó có 1 lượt realtime áp dụng lại dữ liệu (VD: do CHÍNH máy này ghi xong rồi Firebase
  // báo lại — xem CloudVault._onData) đúng lúc hasUnsavedChanges vừa được xoá (ngay sau khi autosave ở
  // đây chạy xong) và không có ô nào đang focus (màn hình quét QR không có input nào), _isSafeToApply()
  // trả về true -> bản KT_INPUTS CŨ từ Cloud ghi đè mất tiến độ vừa quét trong bộ nhớ máy, dù dữ liệu
  // vẫn còn nguyên trong ccKhoResults/giScanLog (nên "Xem GI đã quét" vẫn đúng) — khiến cột "KT =" hiện
  // lại 0 dù vừa quét xong cả locator. Đây chính là lỗi user báo cáo (quét xong A27, thoát camera ra
  // thấy KT = 0 hết dù "Xem GI đã quét" vẫn liệt kê đủ 26 GI của A27).
  scheduleAutoSaveToCloud('qrscan', [STORAGE_KEY_CCRESULTS, STORAGE_KEY_KT_INPUTS, STORAGE_KEY_SCANNED_GI, STORAGE_KEY_GI_LOG], 'Kết quả quét QR');
  updateQrGiClearBtn();
  return response;
}

// Nút "🗑 Đã quét: N GI" luôn hiện sẵn ngay trên trang Kiểm tồn kho (cạnh nút "📷 Quét mã") — không
// cần mở camera lên mới xoá được lịch sử quét như trước, vì nhiều lúc người dùng muốn xoá SAU khi
// đã thoát khỏi màn hình quét rồi. Ẩn hẳn nút này khi chưa quét gì (đỡ rối giao diện).
function updateQrGiClearBtn(){
  const btn = document.getElementById('qr-gi-clear-btn');
  const countEl = document.getElementById('qr-gi-clear-count');
  const viewBtn = document.getElementById('btn-view-gi-log');
  if(viewBtn) viewBtn.style.display = giScanLog.length > 0 ? '' : 'none';
  if(!btn) return;
  const n = scannedGiSet.size;
  if(countEl) countEl.textContent = fmt(n);
  btn.style.display = n > 0 ? '' : 'none';
}

// Popup "Xem GI đã quét" — liệt kê TỪNG GI No. đã quét, nhóm theo Kho -> Locator -> Mã hàng/PO/OQC,
// để đối chiếu tay khi phát hiện 1 locator bị thiếu 1 pallet nào đó (biết đúng GI nào đã tính vào
// vị trí này, không phải đoán theo tổng số lượng).
function renderGiLogPopup(){
  const el = document.getElementById('gi-log-content');
  if(!el) return;
  if(!giScanLog.length){
    el.innerHTML = `<div style="text-align:center; color:var(--muted-2); font-style:italic; padding:24px 0;">Chưa quét GI nào.</div>`;
    return;
  }
  const khoOrder = CC_KHO_LIST.map(k => k.label);
  const byKho = new Map();
  giScanLog.forEach(g => {
    if(!byKho.has(g.kho)) byKho.set(g.kho, new Map());
    const byLoc = byKho.get(g.kho);
    if(!byLoc.has(g.locator)) byLoc.set(g.locator, new Map());
    const byItem = byLoc.get(g.locator);
    const key = g.item + '|' + (g.custpo || '') + '|' + g.oqc;
    if(!byItem.has(key)) byItem.set(key, { item: g.item, custpo: g.custpo, oqc: g.oqc, gis: [] });
    byItem.get(key).gis.push(g);
  });
  const khoKeys = [...byKho.keys()].sort((a, b) => khoOrder.indexOf(a) - khoOrder.indexOf(b));
  let html = '';
  khoKeys.forEach(kho => {
    html += `<div class="ps-compact-kho">${escHtml(kho)}</div>`;
    const byLoc = byKho.get(kho);
    const locKeys = [...byLoc.keys()].sort((a, b) => String(a).localeCompare(String(b), 'vi', { numeric:true }));
    locKeys.forEach(loc => {
      const byItem = byLoc.get(loc);
      const totalGi = [...byItem.values()].reduce((s, v) => s + v.gis.length, 0);
      html += `<div class="ps-compact-loc"><span>📍 ${escHtml(loc)}</span><span class="ps-cl-sub">${fmt(totalGi)} GI</span></div>`;
      [...byItem.values()].forEach(v => {
        const poHtml = v.custpo ? ` <span class="po">(PO ${escHtml(v.custpo)})</span>` : '';
        const giListHtml = v.gis.map(g => `${escHtml(g.gi.toUpperCase())} (${fmt(g.qty)})`).join(' &middot; ');
        html += `<div class="ps-compact-item">
          <div>
            <div class="ps-ci-name"><b>${escHtml(v.item)}</b>${poHtml} ${oqcBadge(v.oqc)}</div>
            <div class="ps-ci-detail">${giListHtml}</div>
          </div>
        </div>`;
      });
    });
  });
  el.innerHTML = html;
}
// Khôi phục lại TOÀN BỘ ô "Kiểm thực tế" (ktInputValues) theo ĐÚNG nhật ký GI đã quét (giScanLog) —
// dùng khi gặp đúng lỗi vừa sửa ở trên (autosave quét QR trước đây thiếu STORAGE_KEY_KT_INPUTS, có
// thể bị Cloud đè mất tiến độ dù giScanLog/ccKhoResults vẫn còn nguyên). Tính lại từ đầu theo đúng
// thứ tự đã quét (mergePalletIntoKtTally) cho từng dòng CÓ MẶT trong nhật ký — không đụng tới các
// dòng khác không liên quan.
function ccRecoverKtInputsFromGiLog(){
  if(!giScanLog.length){ alert('Chưa có nhật ký GI nào để khôi phục.'); return; }
  const ok = confirm(`Tính lại ô "Kiểm thực tế" cho các dòng có trong nhật ký GI đã quét (tổng ${fmt(giScanLog.length)} GI)?\n\nDùng khi ô Kiểm thực tế bị mất/về 0 dù đã quét QR xong. Không ảnh hưởng tới các dòng khác không có trong nhật ký này.`);
  if(!ok) return;
  const affectedRowKeys = new Set();
  giScanLog.forEach(g => { if(g.rowKey) affectedRowKeys.add(g.rowKey); });
  // Xoá sạch giá trị cũ của ĐÚNG các dòng bị ảnh hưởng trước, rồi tính lại từ đầu theo thứ tự trong
  // nhật ký — tránh cộng chồng lên phần có thể vẫn còn đúng, đảm bảo kết quả khớp 100% với nhật ký.
  affectedRowKeys.forEach(k => { delete ktInputValues[k]; });
  giScanLog.forEach(g => {
    if(!g.rowKey) return;
    ktInputValues[g.rowKey] = mergePalletIntoKtTally(ktInputValues[g.rowKey], g.qty);
  });
  saveStateToStorage();
  CC_KHO_LIST.forEach(k => {
    const result = ccKhoResults[k.label];
    if(!result) return;
    if(result.mode === 'locator') ccRenderLocatorCards(k.code, k.label, result.list);
    else ccRenderKhoResult(k.code, k.label, result.mode, result.list);
  });
  scheduleAutoSaveToCloud('confirm', [STORAGE_KEY_KT_INPUTS], 'Khôi phục ô Kiểm thực tế từ nhật ký quét');
  alert(`✓ Đã khôi phục ${fmt(affectedRowKeys.size)} dòng theo đúng nhật ký ${fmt(giScanLog.length)} GI đã quét.`);
}
const giLogRecoverBtn = document.getElementById('gi-log-recover-btn');
if(giLogRecoverBtn) giLogRecoverBtn.addEventListener('click', ccRecoverKtInputsFromGiLog);

const btnViewGiLog = document.getElementById('btn-view-gi-log');
if(btnViewGiLog) btnViewGiLog.addEventListener('click', () => {
  renderGiLogPopup();
  const overlay = document.getElementById('gi-log-overlay');
  if(overlay) overlay.classList.add('show');
});
const giLogCloseBtn = document.getElementById('gi-log-close');
if(giLogCloseBtn) giLogCloseBtn.addEventListener('click', () => {
  const overlay = document.getElementById('gi-log-overlay');
  if(overlay) overlay.classList.remove('show');
});

/* ============ Thư viện CBM theo mã hàng (gom từ Plan) ============ */
let _itemCbmPendingConflicts = [];

function itemCbmShowConflictPopup(conflicts){
  _itemCbmPendingConflicts = conflicts;
  const noteEl = document.getElementById('item-cbm-conflict-note');
  if(noteEl) noteEl.textContent = `Phát hiện ${conflicts.length} mã có CBM/đơn vị khác với dữ liệu đã lưu trước đó (lệch trên 0.5%) — chọn giữ bản cũ hay bản mới cho từng mã, hoặc dùng 2 nút gộp nhanh bên trên.`;
  itemCbmRenderConflictList();
  const overlay = document.getElementById('item-cbm-conflict-overlay');
  if(overlay) overlay.classList.add('show');
}

function itemCbmRenderConflictList(){
  const listEl = document.getElementById('item-cbm-conflict-list');
  if(!listEl) return;
  if(!_itemCbmPendingConflicts.length){
    listEl.innerHTML = `<div style="text-align:center; color:var(--teal); font-weight:700; padding:16px 0;">✓ Đã xử lý xong tất cả.</div>`;
    return;
  }
  listEl.innerHTML = _itemCbmPendingConflicts.map(c => `
    <div class="ps-compact-item">
      <div class="ps-ci-name"><b>${escHtml(c.item)}</b></div>
      <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
        <span style="font-size:11px; color:#888;">Cũ: <b>${fmtDec(c.oldCbm,4)}</b></span>
        <span style="font-size:11px; color:#888;">Mới: <b>${fmtDec(c.newCbm,4)}</b></span>
        <button type="button" class="btn-export-excel item-cbm-keep-old-btn" data-item="${escAttr(c.item)}" style="font-size:11px; padding:3px 8px;">Giữ cũ</button>
        <button type="button" class="btn-export-excel item-cbm-keep-new-btn" data-item="${escAttr(c.item)}" style="font-size:11px; padding:3px 8px;">Giữ mới</button>
      </div>
    </div>`).join('');
}

function itemCbmResolveConflict(item, keepNew){
  const idx = _itemCbmPendingConflicts.findIndex(c => c.item === item);
  if(idx === -1) return;
  const c = _itemCbmPendingConflicts[idx];
  if(keepNew) itemCbmLibrary[item] = { cbm: c.newCbm, updatedAt: new Date().toISOString(), source: c.newSource };
  _itemCbmPendingConflicts.splice(idx, 1);
  saveStateToStorage();
  scheduleAutoSaveToCloud('itemcbm', [STORAGE_KEY_ITEM_CBM], 'Cập nhật thư viện CBM');
  itemCbmRenderConflictList();
}

document.addEventListener('click', (e) => {
  const keepOldBtn = e.target.closest('.item-cbm-keep-old-btn');
  if(keepOldBtn){ itemCbmResolveConflict(keepOldBtn.dataset.item, false); return; }
  const keepNewBtn = e.target.closest('.item-cbm-keep-new-btn');
  if(keepNewBtn){ itemCbmResolveConflict(keepNewBtn.dataset.item, true); return; }
});
const itemCbmKeepAllOldBtn = document.getElementById('item-cbm-keep-all-old');
if(itemCbmKeepAllOldBtn) itemCbmKeepAllOldBtn.addEventListener('click', () => {
  _itemCbmPendingConflicts = [];
  itemCbmRenderConflictList();
});
const itemCbmKeepAllNewBtn = document.getElementById('item-cbm-keep-all-new');
if(itemCbmKeepAllNewBtn) itemCbmKeepAllNewBtn.addEventListener('click', () => {
  const now = new Date().toISOString();
  _itemCbmPendingConflicts.forEach(c => { itemCbmLibrary[c.item] = { cbm: c.newCbm, updatedAt: now, source: c.newSource }; });
  _itemCbmPendingConflicts = [];
  saveStateToStorage();
  scheduleAutoSaveToCloud('itemcbm', [STORAGE_KEY_ITEM_CBM], 'Cập nhật thư viện CBM');
  itemCbmRenderConflictList();
});
const itemCbmConflictCloseBtn = document.getElementById('item-cbm-conflict-close');
if(itemCbmConflictCloseBtn) itemCbmConflictCloseBtn.addEventListener('click', () => {
  const overlay = document.getElementById('item-cbm-conflict-overlay');
  if(overlay) overlay.classList.remove('show');
});

// Tồn kho theo CBM (m³) cho 3 kho 2B/3A/3B — tính bằng: với mỗi mã hàng, gộp TỔNG SL tồn (mọi
// locator, mọi OQC, giống hệt cách "qty_by_kho" đang gộp tổng SL theo kho ở nơi khác trong app,
// KHÔNG lọc PASS/loại locator Pick-Loading-Prod-SPP như bảng Đề xuất kiểm) của kho đó, nhân với
// CBM/đơn vị lấy từ Thư viện CBM, rồi cộng dồn qua mọi mã hàng -> ra tổng m³ đang tồn của kho đó.
// Mã hàng nào đang có tồn kho nhưng CHƯA có trong Thư viện CBM thì tạm bỏ qua (không tính được),
// đếm số lượng để cảnh báo ngay dưới biểu đồ cho biết số liệu có thể đang thấp hơn thực tế.
function computeKhoCbmTotals(){
  const totals = {}; CC_KHO_LIST.forEach(k => totals[k.code] = 0);
  const missingItems = new Set();
  if(!currentData) return { totals, missingCount: 0 };
  const raw = getRawRows(currentData);
  const byKhoItem = new Map(); // 'code||item' -> tổng SL tồn
  raw.forEach(r => {
    const khoLabel = r[RAW_KEY_IDX.kho], item = r[RAW_KEY_IDX.item], qty = Number(r[RAW_KEY_IDX.qty]) || 0;
    if(!item || !khoLabel || !qty) return;
    const khoDef = CC_KHO_LIST.find(k => k.label === khoLabel);
    if(!khoDef) return; // chỉ tính đúng 3 kho 2B/3A/3B, bỏ qua các kho khác (VD: Kho DG1)
    const key = khoDef.code + '||' + item;
    byKhoItem.set(key, (byKhoItem.get(key) || 0) + qty);
  });
  byKhoItem.forEach((qty, key) => {
    const [code, item] = key.split('||');
    const entry = itemCbmLibrary[item];
    if(entry && typeof entry.cbm === 'number') totals[code] += qty * entry.cbm;
    else missingItems.add(item);
  });
  return { totals, missingCount: missingItems.size };
}
const KHO_CBM_CHART_COLORS = { '3B': '#0E8F76', '3A': '#2C6FCB', '2B': '#F5A623' };
function buildKhoCbmChartHtml(){
  const title = `<div style="font-weight:700; font-size:13px; margin-bottom:4px;">📊 Tồn kho theo CBM (m³) — Tổng SL tồn mỗi mã hàng × CBM/đơn vị, cộng dồn theo từng kho</div>`;
  if(!currentData){
    return title + `<div class="kho-empty" style="padding:20px 0;">Chưa có dữ liệu tồn kho — hãy tải file tồn kho trước.</div><div style="border-top:1px solid var(--line); margin:16px 0;"></div>`;
  }
  const { totals, missingCount } = computeKhoCbmTotals();
  const order = ['3B','3A','2B'];
  const maxVal = Math.max(0.0001, ...order.map(c => totals[c] || 0));
  const barsHtml = order.map(code => {
    const val = totals[code] || 0;
    const pct = val > 0 ? Math.max(3, Math.round((val / maxVal) * 100)) : 1;
    return `<div class="tx-chart-bar-col">
      <div class="tx-chart-bar-value" style="color:${KHO_CBM_CHART_COLORS[code]}">${fmtDec(val,2)} m³</div>
      <div class="tx-chart-bar" style="height:${pct}%; background:${KHO_CBM_CHART_COLORS[code]};"></div>
      <div class="tx-chart-bar-label">Kho ${code}</div>
    </div>`;
  }).join('');
  const noteHtml = missingCount
    ? `<div class="desc" style="text-align:center; margin-top:6px;">⚠ ${missingCount} mã hàng đang có tồn kho nhưng chưa có CBM trong thư viện — tạm bỏ qua khi tính, số m³ trên có thể thấp hơn thực tế.</div>`
    : '';
  return title + `<div class="tx-chart-wrap">${barsHtml}</div>${noteHtml}<div style="border-top:1px solid var(--line); margin:16px 0;"></div>`;
}

function itemCbmRenderLibrary(){
  const el = document.getElementById('item-cbm-library-content');
  if(!el) return;
  const items = Object.keys(itemCbmLibrary).sort();
  const chartHtml = buildKhoCbmChartHtml();
  if(!items.length){
    el.innerHTML = chartHtml + `<div style="text-align:center; color:var(--muted-2); font-style:italic; padding:24px 0;">Chưa có dữ liệu — tải 1 Plan (Row/FC/HCP) có cột CBM để bắt đầu gom.</div>`;
    return;
  }
  el.innerHTML = chartHtml + `<table class="kho-detail-table"><thead><tr><th>STT</th><th>Item No.</th><th style="text-align:right">CBM/đơn vị</th><th>Cập nhật lúc</th></tr></thead><tbody>
    ${items.map((item, idx) => {
      const e = itemCbmLibrary[item];
      const dt = e.updatedAt ? new Date(e.updatedAt) : null;
      return `<tr><td>${idx+1}</td><td>${escHtml(item)}</td><td style="text-align:right">${fmtDec(e.cbm,4)}</td><td>${dt ? escHtml(fmtDateTime(dt)) : '—'}</td></tr>`;
    }).join('')}
  </tbody></table>`;
}
const itemCbmOpenBtn = document.getElementById('item-cbm-open-library');
if(itemCbmOpenBtn) itemCbmOpenBtn.addEventListener('click', () => {
  itemCbmRenderLibrary();
  const overlay = document.getElementById('item-cbm-library-overlay');
  if(overlay) overlay.classList.add('show');
});
const itemCbmLibCloseBtn = document.getElementById('item-cbm-library-close');
if(itemCbmLibCloseBtn) itemCbmLibCloseBtn.addEventListener('click', () => {
  const overlay = document.getElementById('item-cbm-library-overlay');
  if(overlay) overlay.classList.remove('show');
});
const itemCbmExportBtn = document.getElementById('item-cbm-export-excel');
if(itemCbmExportBtn) itemCbmExportBtn.addEventListener('click', () => {
  if(!LIB_XLSX_OK){ alert('Không xuất được Excel: thư viện SheetJS chưa tải được (cần Internet). Hãy mở file này bằng Chrome có kết nối mạng rồi thử lại.'); return; }
  const items = Object.keys(itemCbmLibrary).sort();
  const header = ['STT', 'Item No.', 'CBM/don vi', 'Cap nhat luc'];
  const rows = items.map((item, idx) => {
    const e = itemCbmLibrary[item];
    const dt = e.updatedAt ? new Date(e.updatedAt) : null;
    return [idx+1, item, e.cbm, dt ? fmtDateTime(dt) : ''];
  });
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([header, ...rows]);
  ws['!cols'] = [{wch:6},{wch:16},{wch:14},{wch:18}];
  XLSX.utils.book_append_sheet(wb, ws, 'Thu vien CBM'.slice(0,31));
  const pad = n => String(n).padStart(2,'0');
  const now = new Date();
  const stamp = `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}`;
  XLSX.writeFile(wb, `Thu_vien_CBM_${stamp}.xlsx`);
});


// Dùng chung cho cả nút trong overlay quét (qr-scan-clear-history-btn) lẫn nút ngoài trang chính
// (qr-gi-clear-btn) — cùng 1 hành vi, chỉ khác nơi hiện thông báo kết quả.
function qrScanClearHistory(useOverlayStatus){
  if(!scannedGiSet.size){
    if(useOverlayStatus) qrScanSetStatus('Lịch sử quét đang trống — chưa có gì để xoá.', '');
    else alert('Lịch sử quét đang trống — chưa có gì để xoá.');
    return;
  }
  const ok = confirm(
    `Xoá lịch sử ${scannedGiSet.size} GI No. đã quét?\n\n` +
    `Sau khi xoá, các mã ĐÃ quét trước đó có thể quét lại được (không còn báo "đã quét trước đó — không quét trùng" nữa). ` +
    `LƯU Ý: nếu lỡ quét lại đúng pallet đã tính số lượng rồi, số lượng sẽ bị CỘNG THÊM 1 LẦN NỮA vào ô kiểm thực tế — chỉ xoá khi chắc chắn cần quét lại (VD: vừa quét nhầm hàng loạt).`
  );
  if(!ok) return;
  const clearedCount = scannedGiSet.size;
  scannedGiSet.forEach(g => _deletedGiKeys.add(g));
  scannedGiSet.clear();
  giScanLog = [];
  saveStateToStorage();
  updateQrGiClearBtn();
  if(useOverlayStatus){
    qrScanSetStatus(`Đã xoá lịch sử ${fmt(clearedCount)} GI đã quét — có thể quét lại bình thường.`, 'ok');
    qrScanAddLog(`🗑 Đã xoá lịch sử ${clearedCount} GI đã quét trong phiên.`, 'ok');
  } else if(typeof showAppToast === 'function'){
    showAppToast(`✓ Đã xoá lịch sử ${clearedCount} GI đã quét.`);
  }
}

const btnOpenQrScan = document.getElementById('btn-open-qr-scan');
if(btnOpenQrScan) btnOpenQrScan.addEventListener('click', openQrScanOverlay);
const qrScanCloseBtn = document.getElementById('qr-scan-close-btn');
if(qrScanCloseBtn) qrScanCloseBtn.addEventListener('click', closeQrScanOverlay);
const qrScanResetLocBtn = document.getElementById('qr-scan-reset-loc-btn');
if(qrScanResetLocBtn) qrScanResetLocBtn.addEventListener('click', qrScanResetLocator);
const qrScanItemLockBtn = document.getElementById('qr-scan-item-lock-btn');
if(qrScanItemLockBtn) qrScanItemLockBtn.addEventListener('click', qrScanToggleItemLock);
const qrScanOqcBtnsWrap = document.getElementById('qr-scan-oqc-btns');
if(qrScanOqcBtnsWrap) qrScanOqcBtnsWrap.addEventListener('click', (e) => {
  const btn = e.target.closest('.qr-scan-oqc-btn');
  if(!btn) return;
  qrScanOqcOverride = btn.dataset.oqc || null;
  qrScanUpdateOqcBtns();
  qrScanSetStatus(
    qrScanOqcOverride
      ? `Đã chọn quét theo OQC = ${qrScanOqcOverride === 'Khac' ? 'Khác' : qrScanOqcOverride} — nếu hệ thống ghi khác, sẽ báo "Sai OQC" và tách riêng, không cộng nhầm.`
      : 'Đã quay lại tin theo OQC hệ thống ghi cho từng pallet (mặc định).',
    ''
  );
});
const qrScanClearHistoryBtn = document.getElementById('qr-scan-clear-history-btn');
if(qrScanClearHistoryBtn) qrScanClearHistoryBtn.addEventListener('click', () => qrScanClearHistory(true));
const qrGiClearBtn = document.getElementById('qr-gi-clear-btn');
if(qrGiClearBtn) qrGiClearBtn.addEventListener('click', () => qrScanClearHistory(false));

// Nhập tay số GI No. — dùng khi mã QR/vạch trên tem quá mờ/hỏng/góc chụp khó, camera không đọc
// được, nhưng vẫn đọc được số GI No. in trên tem bằng mắt thường. Xử lý y hệt 1 lượt quét camera
// thành công (cùng đi qua handleQrScanResult, cùng áp dụng mọi kiểm tra sai vị trí/trùng lặp).
function qrScanSubmitManual(){
  const input = document.getElementById('qr-scan-manual-input');
  if(!input) return;
  const val = input.value.trim();
  if(!val){ qrScanSetStatus('Chưa nhập số GI No. nào.', 'err'); return; }
  input.value = '';
  handleQrScanResult(val);
}
const qrScanManualBtn = document.getElementById('qr-scan-manual-btn');
if(qrScanManualBtn) qrScanManualBtn.addEventListener('click', qrScanSubmitManual);
const qrScanManualInput = document.getElementById('qr-scan-manual-input');
if(qrScanManualInput) qrScanManualInput.addEventListener('keydown', (e) => {
  if(e.key === 'Enter'){ e.preventDefault(); qrScanSubmitManual(); }
});

/* ============ Phiếu pick theo container — sắp theo thứ tự đi 1 vòng không quay lui, FIFO theo
   ngày nhận (Lot/GI No. cũ nhất lấy trước), giới hạn đúng số lượng cần lấy theo kế hoạch. Xem
   trên màn hình dạng bảng gộp theo kho (kèm tổng từng kho), xuất ra Excel khi cần. ============ */
// Thứ tự "đi bộ" của locator trong từng kho (biết càng chi tiết thì phiếu càng đỡ đi lại lộn xộn):
//  - Kho 3B (D3B-FG-A01..A33): đi theo hình chữ U — cột trái A01→A15, vòng sang cột phải A16→A33
//    (đúng thứ tự vật lý đã dùng ở Sơ đồ kho 3B).
//  - Kho 3A (rack 3A-...): dùng đúng RACK3A_LOCATOR_ORDER (thứ tự đọc trong sơ đồ layout gốc).
//  - Các locator khác (Floor 3A/M1, 2B, DG1, PROD/Loading/Pick...): chưa có sơ đồ vật lý xác nhận
//    -> xếp theo TÊN, đặt sau tất cả các vị trí đã biết thứ tự ở trên.
function pickWalkOrderKey(locator){
  const loc = String(locator || '');
  let m = loc.match(/^D3B-FG-A(\d+)$/i);
  if(m){
    const n = Number(m[1]);
    return [0, n <= 15 ? n : 15 + (n - 16)];
  }
  if(typeof RACK3A_LOCATOR_ORDER !== 'undefined' && RACK3A_LOCATOR_ORDER.has(loc)){
    return [0, RACK3A_LOCATOR_ORDER.get(loc)];
  }
  return [1, loc];
}
function comparePickWalkOrder(a, b){
  const ka = pickWalkOrderKey(a.locator), kb = pickWalkOrderKey(b.locator);
  if(ka[0] !== kb[0]) return ka[0] - kb[0];
  if(typeof ka[1] === 'number' && typeof kb[1] === 'number') return ka[1] - kb[1];
  return String(ka[1]).localeCompare(String(kb[1]), 'vi', { numeric: true });
}
function pickSlipParseDate(s){
  const m = String(s || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if(!m) return null;
  return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1])).getTime();
}
const PICK_SLIP_KHO_ORDER = { 'Kho 2B': 0, 'Kho 3A': 1, 'Kho 3B': 2, 'Kho DG1': 3 };

function buildPickSlipForContainer(type, cNo, instanceKey){
  // Container cùng type+cNo CÓ THỂ xuất hiện nhiều lần (VD: 2 lượt xuất FC-1 khác ngày/giờ/Invoice
  // khác nhau) — nếu chỉ tìm theo type+cNo sẽ luôn trúng đúng DÒNG ĐẦU TIÊN khớp, dù người dùng bấm
  // vào dòng khác. instanceKey (gồm cả ngày load + giờ plan) mới xác định ĐÚNG 1 lượt xuất cụ thể,
  // nên luôn ưu tiên dùng nó khi có; chỉ fallback về type+cNo cho các lời gọi cũ chưa kịp truyền vào.
  const row = instanceKey
    ? (contPickAllRows || []).find(r => r.instanceKey === instanceKey)
    : (contPickAllRows || []).find(r => r.type === type && String(r.cNo) === String(cNo));
  if(!row) return null;

  const shortages = [];
  const allLocs = []; // TẤT CẢ vị trí đang có hàng (PASS + NG) — lấy đúng logic như khi hover 1 dòng container

  (row.items || []).forEach(it => {
    // Toàn bộ vị trí hiện có của mã hàng + PO này, y hệt dữ liệu hiển thị khi hover chuột vào dòng
    // container — LOẠI vị trí "Prod" (khu trung chuyển/sản xuất), không tính là hàng sẵn sàng để pick.
    const locs = buildItemLocatorDetail(it.item, it.po, true);

    // Đếm số pallet tại từng vị trí — 1 GI No = 1 pallet, lấy từ dữ liệu raw rows chi tiết (nếu không
    // có GI No thì mỗi dòng raw tính là 1 pallet).
    const rawRows = getRawRows(currentData).filter(r =>
      String(r[RAW_KEY_IDX.item] || '').toLowerCase() === it.item.toLowerCase() &&
      String(r[RAW_KEY_IDX.custpo] || '').trim().toLowerCase() === (it.po || '').trim().toLowerCase()
    );
    const palletSetMap = new Map(); // kho||locator||oqc -> Set các GI No (mỗi GI = 1 pallet)
    rawRows.forEach((r, idx) => {
      const key = r[RAW_KEY_IDX.kho] + '||' + r[RAW_KEY_IDX.locator] + '||' + String(r[RAW_KEY_IDX.oqc] || '').toUpperCase();
      if(!palletSetMap.has(key)) palletSetMap.set(key, new Set());
      const gi = r[RAW_KEY_IDX.gi];
      palletSetMap.get(key).add(gi ? String(gi) : ('__row' + idx));
    });

    locs.forEach(l => {
      const key = l.kho + '||' + l.locator + '||' + String(l.oqc || '').toUpperCase();
      const pallets = palletSetMap.has(key) ? palletSetMap.get(key).size : (l.qty > 0 ? 1 : 0);
      allLocs.push({ kho: l.kho, locator: l.locator, item: it.item, po: it.po, oqc: l.oqc, onHand: l.qty, pallets });
    });

    // Cảnh báo thiếu hàng: tổng tồn PASS của mã+PO này không đủ so với kế hoạch (không cần biết lấy ở đâu).
    const passOnHand = locs.reduce((s, l) => s + (l.oqc === 'PASS' ? l.qty : 0), 0);
    if(passOnHand < it.qty){
      shortages.push({ item: it.item, po: it.po, missing: it.qty - passOnHand });
    }
  });

  // Đếm số PO KHÁC NHAU hiện đang có tồn kho cho MỖI MÃ HÀNG (không lọc theo PO — xét toàn bộ tồn
  // kho của mã đó, loại vị trí "Prod") — cảnh báo dễ lấy nhầm PO khi 1 mã có nhiều PO cùng tồn tại.
  const itemAllPoMap = new Map(); // item (lowercase) -> Set các Cust PO đang tồn
  const seenItemCodes = new Set();
  (row.items || []).forEach(it => {
    const itemKey = it.item.toLowerCase();
    if(seenItemCodes.has(itemKey)) return;
    seenItemCodes.add(itemKey);
    const allPoLocs = buildItemLocatorDetail(it.item, null, true);
    const poSet = new Set(allPoLocs.map(l => (l.custpo || '').trim()).filter(Boolean));
    itemAllPoMap.set(itemKey, poSet);
  });
  allLocs.forEach(g => { g.itemPoCount = (itemAllPoMap.get(g.item.toLowerCase()) || new Set()).size; });

  // Nhóm theo TỪNG MÃ HÀNG (đúng thứ tự trong kế hoạch) trước, trong mỗi mã mới sắp theo kho/locator.
  const itemOrderMap = new Map();
  (row.items || []).forEach((it, idx) => itemOrderMap.set(it.item + '||' + (it.po || ''), idx));
  allLocs.sort((a, b) => {
    const ia = itemOrderMap.get(a.item + '||' + (a.po || '')) ?? 999;
    const ib = itemOrderMap.get(b.item + '||' + (b.po || '')) ?? 999;
    if(ia !== ib) return ia - ib;
    const ka = PICK_SLIP_KHO_ORDER[a.kho] ?? 9, kb = PICK_SLIP_KHO_ORDER[b.kho] ?? 9;
    if(ka !== kb) return ka - kb;
    return comparePickWalkOrder(a, b);
  });

  // Gắn thêm SL kế hoạch (theo đúng mã hàng + PO, lấy từ Plan) vào từng dòng để dễ đối chiếu.
  const planQtyMap = new Map();
  (row.items || []).forEach(it => planQtyMap.set(it.item + '||' + (it.po || ''), it.qty));
  allLocs.forEach(g => { g.planQty = planQtyMap.get(g.item + '||' + (g.po || '')) || 0; });

  // Ước tính CBM cho từng vị trí: CBM/đơn vị = Tổng CBM kế hoạch của mã này (lấy từ bảng Plan, cột
  // CBM) chia cho SL kế hoạch của mã đó, rồi nhân với SL tồn thực tế đang có ở TỪNG vị trí — để biết
  // ngay lấy hàng ở vị trí nào thì chiếm khoảng bao nhiêu khối (m3), không cần tính tay.
  const planCbmPerUnitMap = new Map();
  (row.items || []).forEach(it => {
    const key = it.item + '||' + (it.po || '');
    planCbmPerUnitMap.set(key, it.qty > 0 ? (it.cbm || 0) / it.qty : 0);
  });
  allLocs.forEach(g => {
    const cbmPerUnit = planCbmPerUnitMap.get(g.item + '||' + (g.po || '')) || 0;
    g.cbmPerUnit = cbmPerUnit;
    g.cbm = g.onHand * cbmPerUnit;
  });

  // Tổng tồn kho TOÀN KHO (tất cả vị trí, PASS+NG) cho từng mã hàng+PO, cộng lại cho cả container.
  const itemPoOnHandTotal = new Map();
  allLocs.forEach(l => {
    const ip = l.item + '||' + (l.po || '');
    itemPoOnHandTotal.set(ip, (itemPoOnHandTotal.get(ip) || 0) + l.onHand);
  });
  const totalOnHandWarehouse = [...itemPoOnHandTotal.values()].reduce((s, v) => s + v, 0);
  const totalCbmWarehouse = allLocs.reduce((s, l) => s + (l.cbm || 0), 0);

  // Đánh dấu mã hàng DƯ HÀNG — tổng tồn (toàn kho) của mã+PO này nhiều hơn SL kế hoạch cần lấy.
  allLocs.forEach(g => {
    const ip = g.item + '||' + (g.po || '');
    const totalOnHand = itemPoOnHandTotal.get(ip) || 0;
    g.surplusQty = Math.max(0, totalOnHand - g.planQty);
    g.isSurplus = g.surplusQty > 0;
  });

  return { row, grouped: allLocs, shortages, totalOnHandWarehouse, totalCbmWarehouse };
}

let currentPickSlipData = null; // slip đang mở trong modal — dùng khi bấm "Xuất Excel"
let pickSlipViewMode = 'item'; // 'item' = nhóm theo mã hàng (mặc định) | 'locator' = nhóm theo locator

function renderPickSlipContent(type, cNo, instanceKey){
  const contentEl = document.getElementById('pick-slip-content');
  if(!contentEl) return;
  const slip = buildPickSlipForContainer(type, cNo, instanceKey);
  currentPickSlipData = slip;
  pickSlipViewMode = 'item';
  if(!slip){
    contentEl.innerHTML = `<div style="padding:30px; text-align:center; color:#888;">Không tìm thấy container ${escHtml(type)}-${escHtml(String(cNo))}.</div>`;
    return;
  }
  renderPickSlipBody();
}

// Dựng phần bảng khi nhóm theo TỪNG MÃ HÀNG (mặc định) — mỗi mã 1 khối, trong đó lại nhóm theo Kho.
function buildPickSlipBodyByItem(grouped){
  let stt = 0;
  let currentKey = null;
  let currentKho = null;
  let bodyHtml = '';
  let itemOnHandSubtotal = 0;
  let itemPalletSubtotal = 0;
  let itemCbmSubtotal = 0;
  let khoOnHandSubtotal = 0;
  let khoPalletSubtotal = 0;
  let khoCbmSubtotal = 0;
  grouped.forEach((g, i) => {
    const key = g.item + '||' + (g.po || '');
    if(key !== currentKey){
      if(currentKey !== null){
        bodyHtml += `<tr class="ps-subtotal-row"><td colspan="3" style="text-align:right;">Tổng ${escHtml(currentKho)}</td><td class="num">${fmt(khoOnHandSubtotal)}</td><td class="num">${fmt(khoPalletSubtotal)}</td><td class="num">${fmtDec(khoCbmSubtotal,2)}</td></tr>`;
        bodyHtml += `<tr class="ps-total-row"><td colspan="3" style="text-align:right;">Tổng mã này</td><td class="num">${fmt(itemOnHandSubtotal)}</td><td class="num">${fmt(itemPalletSubtotal)}</td><td class="num">${fmtDec(itemCbmSubtotal,2)}</td></tr></tbody></table>`;
      }
      currentKey = key;
      currentKho = null;
      itemOnHandSubtotal = 0;
      itemPalletSubtotal = 0;
      itemCbmSubtotal = 0;
      stt = 0;
      const surplusBadge = g.isSurplus ? `<span class="ps-kho-title-surplus-badge">⚠ Dư ${fmt(g.surplusQty)}</span>` : '';
      const multiPoBadge = g.itemPoCount > 1 ? `<span class="ps-kho-title-multipo-badge">Có ${g.itemPoCount} PO</span>` : '';
      bodyHtml += `<div class="ps-kho-title${g.isSurplus ? ' surplus' : ''}"><span class="ps-kho-title-main">Mã <b>${escHtml(g.item)}</b> — PO <b>${escHtml(g.po || '—')}</b></span><span style="display:flex; gap:6px; flex:none;"><span class="ps-kho-title-kh">KH ${fmt(g.planQty)}</span>${multiPoBadge}${surplusBadge}</span></div><table class="ps-table"><thead><tr><th>#</th><th>Locator</th><th>OQC</th><th style="text-align:right">Tồn kho</th><th style="text-align:right">SL pallet</th><th style="text-align:right">CBM</th></tr></thead><tbody>`;
    }
    if(g.kho !== currentKho){
      if(currentKho !== null){
        bodyHtml += `<tr class="ps-subtotal-row"><td colspan="3" style="text-align:right;">Tổng ${escHtml(currentKho)}</td><td class="num">${fmt(khoOnHandSubtotal)}</td><td class="num">${fmt(khoPalletSubtotal)}</td><td class="num">${fmtDec(khoCbmSubtotal,2)}</td></tr>`;
      }
      currentKho = g.kho;
      khoOnHandSubtotal = 0;
      khoPalletSubtotal = 0;
      khoCbmSubtotal = 0;
      bodyHtml += `<tr class="ps-kho-subrow"><td colspan="6">${escHtml(g.kho)}</td></tr>`;
    }
    stt++;
    itemOnHandSubtotal += g.onHand;
    itemPalletSubtotal += g.pallets;
    itemCbmSubtotal += (g.cbm || 0);
    khoOnHandSubtotal += g.onHand;
    khoPalletSubtotal += g.pallets;
    khoCbmSubtotal += (g.cbm || 0);
    bodyHtml += `<tr${g.isSurplus ? ' class="ps-row-surplus"' : ''}>
      <td>${stt}</td>
      <td><b>${escHtml(g.locator)}</b></td>
      <td>${oqcBadge(g.oqc)}</td>
      <td class="num">${fmt(g.onHand)}</td>
      <td class="num">${fmt(g.pallets)}</td>
      <td class="num">${fmtDec(g.cbm,2)}</td>
    </tr>`;
    if(i === grouped.length - 1){
      bodyHtml += `<tr class="ps-subtotal-row"><td colspan="3" style="text-align:right;">Tổng ${escHtml(currentKho)}</td><td class="num">${fmt(khoOnHandSubtotal)}</td><td class="num">${fmt(khoPalletSubtotal)}</td><td class="num">${fmtDec(khoCbmSubtotal,2)}</td></tr>`;
      bodyHtml += `<tr class="ps-total-row"><td colspan="3" style="text-align:right;">Tổng mã này</td><td class="num">${fmt(itemOnHandSubtotal)}</td><td class="num">${fmt(itemPalletSubtotal)}</td><td class="num">${fmtDec(itemCbmSubtotal,2)}</td></tr></tbody></table>`;
    }
  });
  return bodyHtml;
}

// Dựng phần bảng khi nhóm theo TỪNG LOCATOR — đi 1 vòng kho theo đúng lối đi, mỗi locator liệt kê
// hết các mã hàng + PO đang tồn tại đó (hữu ích khi 1 vị trí có nhiều mã, đỡ phải lật qua lật lại).
function buildPickSlipBodyByLocator(grouped){
  const sorted = grouped.slice().sort((a, b) => {
    const ka = PICK_SLIP_KHO_ORDER[a.kho] ?? 9, kb = PICK_SLIP_KHO_ORDER[b.kho] ?? 9;
    if(ka !== kb) return ka - kb;
    const walkCmp = comparePickWalkOrder(a, b);
    if(walkCmp !== 0) return walkCmp;
    return a.item.localeCompare(b.item);
  });
  let stt = 0;
  let currentKho = null;
  let currentLocator = null;
  let bodyHtml = '';
  let locatorOnHandSubtotal = 0;
  let locatorPalletSubtotal = 0;
  let locatorCbmSubtotal = 0;
  let khoOnHandSubtotal = 0;
  let khoPalletSubtotal = 0;
  let khoCbmSubtotal = 0;
  sorted.forEach((g, i) => {
    if(g.kho !== currentKho){
      if(currentLocator !== null){
        bodyHtml += `<tr class="ps-subtotal-row"><td colspan="3" style="text-align:right;">Tổng ${escHtml(currentLocator)}</td><td class="num">${fmt(locatorOnHandSubtotal)}</td><td class="num">${fmt(locatorPalletSubtotal)}</td><td class="num">${fmtDec(locatorCbmSubtotal,2)}</td></tr></tbody></table>`;
      }
      if(currentKho !== null){
        bodyHtml += `<div class="ps-kho-subtotal-note">Tổng ${escHtml(currentKho)}: ${fmt(khoOnHandSubtotal)} Pcs · ${fmt(khoPalletSubtotal)} pallet · ${fmtDec(khoCbmSubtotal,2)} CBM</div>`;
      }
      currentKho = g.kho;
      currentLocator = null;
      khoOnHandSubtotal = 0;
      khoPalletSubtotal = 0;
      khoCbmSubtotal = 0;
      bodyHtml += `<div class="ps-kho-title"><span class="ps-kho-title-main">${escHtml(g.kho)}</span></div>`;
    }
    if(g.locator !== currentLocator){
      if(currentLocator !== null){
        bodyHtml += `<tr class="ps-subtotal-row"><td colspan="3" style="text-align:right;">Tổng ${escHtml(currentLocator)}</td><td class="num">${fmt(locatorOnHandSubtotal)}</td><td class="num">${fmt(locatorPalletSubtotal)}</td><td class="num">${fmtDec(locatorCbmSubtotal,2)}</td></tr></tbody></table>`;
      }
      currentLocator = g.locator;
      locatorOnHandSubtotal = 0;
      locatorPalletSubtotal = 0;
      locatorCbmSubtotal = 0;
      stt = 0;
      bodyHtml += `<table class="ps-table"><thead><tr class="ps-loc-header-row"><th colspan="2">📍 ${escHtml(g.locator)}</th><th>OQC</th><th style="text-align:right">Tồn kho</th><th style="text-align:right">SL pallet</th><th style="text-align:right">CBM</th></tr></thead><tbody>`;
    }
    stt++;
    locatorOnHandSubtotal += g.onHand;
    locatorPalletSubtotal += g.pallets;
    locatorCbmSubtotal += (g.cbm || 0);
    khoOnHandSubtotal += g.onHand;
    khoPalletSubtotal += g.pallets;
    khoCbmSubtotal += (g.cbm || 0);
    const surplusBadge = g.isSurplus ? `<span class="ps-item-surplus-badge">⚠ Dư ${fmt(g.surplusQty)} (KH ${fmt(g.planQty)})</span>` : '';
    const multiPoBadge = g.itemPoCount > 1 ? `<span class="ps-item-multipo-badge">Có ${g.itemPoCount} PO</span>` : '';
    bodyHtml += `<tr${g.isSurplus ? ' class="ps-row-surplus"' : ''}>
      <td>${stt}</td>
      <td colspan="1"><b>${escHtml(g.item)}</b>${g.po ? ` <span style="color:#888; font-weight:400;">(PO ${escHtml(g.po)})</span>` : ''}${multiPoBadge}${surplusBadge}</td>
      <td>${oqcBadge(g.oqc)}</td>
      <td class="num">${fmt(g.onHand)}</td>
      <td class="num">${fmt(g.pallets)}</td>
      <td class="num">${fmtDec(g.cbm,2)}</td>
    </tr>`;
    if(i === sorted.length - 1){
      bodyHtml += `<tr class="ps-subtotal-row"><td colspan="3" style="text-align:right;">Tổng ${escHtml(currentLocator)}</td><td class="num">${fmt(locatorOnHandSubtotal)}</td><td class="num">${fmt(locatorPalletSubtotal)}</td><td class="num">${fmtDec(locatorCbmSubtotal,2)}</td></tr></tbody></table>`;
      bodyHtml += `<div class="ps-kho-subtotal-note">Tổng ${escHtml(currentKho)}: ${fmt(khoOnHandSubtotal)} Pcs · ${fmt(khoPalletSubtotal)} pallet · ${fmtDec(khoCbmSubtotal,2)} CBM</div>`;
    }
  });
  return bodyHtml;
}

// Header gọn dùng riêng cho chế độ "Xem theo Locator" — chỉ giữ đúng thông tin cần khi chụp màn hình
// gửi cho nhân viên pick: số cont, ngày load + giờ plan chung 1 dòng, rồi CR và Invoice ở dòng dưới.
function buildPickSlipHeaderCompact(row){
  return `<div class="ps-compact-header">
    <div class="ps-compact-header-top">
      <span class="ps-cc-cont">${escHtml(row.type)}-${escHtml(String(row.cNo))}</span>
      <span class="ps-cc-time">${escHtml(row.loadDate)} · ${escHtml(row.planTime)}</span>
    </div>
    <div class="ps-compact-header-sub">
      <span>CR ${escHtml(row.csr)}</span>
      <span>Inv ${escHtml(row.invoice)}</span>
    </div>
  </div>`;
}

// Bản gọn của bảng theo Locator — mỗi mã hàng chỉ chiếm 1 dòng (tên mã + PO + OQC bên trái, SL/pallet/
// CBM bên phải), tổng mỗi locator hiện ngay trên dòng tiêu đề locator, tổng mỗi kho hiện trên dải
// tiêu đề kho — không tách bảng riêng từng vị trí như bản cũ.
function buildPickSlipBodyByLocatorCompact(grouped){
  const sorted = grouped.slice().sort((a, b) => {
    const ka = PICK_SLIP_KHO_ORDER[a.kho] ?? 9, kb = PICK_SLIP_KHO_ORDER[b.kho] ?? 9;
    if(ka !== kb) return ka - kb;
    const walkCmp = comparePickWalkOrder(a, b);
    if(walkCmp !== 0) return walkCmp;
    return a.item.localeCompare(b.item);
  });
  const locTotals = new Map();
  const khoTotals = new Map();
  sorted.forEach(g => {
    const t = locTotals.get(g.locator) || { onHand: 0, pallets: 0 };
    t.onHand += g.onHand; t.pallets += g.pallets;
    locTotals.set(g.locator, t);
    const kt = khoTotals.get(g.kho) || { onHand: 0, pallets: 0 };
    kt.onHand += g.onHand; kt.pallets += g.pallets;
    khoTotals.set(g.kho, kt);
  });
  let currentKho = null, currentLocator = null;
  let bodyHtml = '';
  sorted.forEach(g => {
    if(g.kho !== currentKho){
      currentKho = g.kho;
      const kt = khoTotals.get(currentKho);
      bodyHtml += `<div class="ps-compact-kho">${escHtml(currentKho)} &nbsp;&mdash;&nbsp; ${fmt(kt.onHand)} Pcs &middot; ${fmt(kt.pallets)} plt</div>`;
    }
    if(g.locator !== currentLocator){
      currentLocator = g.locator;
      const t = locTotals.get(currentLocator);
      bodyHtml += `<div class="ps-compact-loc${g.isSurplus ? ' surplus' : ''}"><span>📍 ${escHtml(currentLocator)}</span><span class="ps-cl-sub">${fmt(t.onHand)} Pcs · ${fmt(t.pallets)} plt</span></div>`;
    }
    const poHtml = g.po ? ` <span class="po">(PO ${escHtml(g.po)})</span>` : '';
    const multiPoHtml = g.itemPoCount > 1 ? ` <span class="ps-item-multipo-badge">${g.itemPoCount} PO</span>` : '';
    const surplusHtml = g.isSurplus ? ` <span class="ps-item-surplus-badge">Dư ${fmt(g.surplusQty)} (KH ${fmt(g.planQty)})</span>` : '';
    bodyHtml += `<div class="ps-compact-item${g.isSurplus ? ' surplus' : ''}">
      <div class="ps-ci-name"><b>${escHtml(g.item)}</b>${poHtml}${multiPoHtml}${surplusHtml} ${oqcBadge(g.oqc)}</div>
      <div class="ps-ci-qty">${fmt(g.onHand)} Pcs · ${fmt(g.pallets)} plt · ${fmtDec(g.cbm,2)} CBM</div>
    </div>`;
  });
  return bodyHtml;
}

// Bản gọn của bảng theo Mã hàng — mỗi mã 1 khối (kèm PO, KH kế hoạch, tổng), trong đó mỗi vị trí
// (locator) chỉ chiếm 1 dòng gọn (tên vị trí + OQC bên trái, SL/pallet/CBM bên phải) thay vì 1 dòng
// bảng nhiều cột như bản cũ. Tổng mỗi kho hiện trên dải tiêu đề kho.
function buildPickSlipBodyByItemCompact(grouped){
  const itemTotals = new Map();
  const khoTotals = new Map();
  grouped.forEach(g => {
    const key = g.item + '||' + (g.po || '');
    const t = itemTotals.get(key) || { onHand: 0, pallets: 0 };
    t.onHand += g.onHand; t.pallets += g.pallets;
    itemTotals.set(key, t);
  });
  let currentKey = null, currentKho = null;
  let bodyHtml = '';
  grouped.forEach(g => {
    const key = g.item + '||' + (g.po || '');
    if(key !== currentKey){
      currentKey = key;
      currentKho = null;
      const t = itemTotals.get(key);
      const multiPoHtml = g.itemPoCount > 1 ? ` <span class="ps-item-multipo-badge">${g.itemPoCount} PO</span>` : '';
      const surplusHtml = g.isSurplus ? ` <span class="ps-item-surplus-badge">Dư ${fmt(g.surplusQty)}</span>` : '';
      bodyHtml += `<div class="ps-compact-item-head${g.isSurplus ? ' surplus' : ''}"><span><b>${escHtml(g.item)}</b> <span class="po">PO ${escHtml(g.po || '—')}</span>${multiPoHtml}${surplusHtml}</span><span class="ps-cl-sub-light">KH ${fmt(g.planQty)} · ${fmt(t.onHand)} Pcs · ${fmt(t.pallets)} plt</span></div>`;
    }
    if(g.kho !== currentKho){
      currentKho = g.kho;
      // Tổng theo kho tính riêng cho ĐÚNG mã hàng này (không cộng dồn qua các mã khác) — nhất quán với
      // cách mỗi khối trong chế độ Mã hàng chỉ nói về 1 mã, giống hệt tổng mỗi locator ở chế độ Locator.
      const kt = { onHand: 0, pallets: 0 };
      grouped.forEach(x => { if(x.item + '||' + (x.po || '') === key && x.kho === currentKho){ kt.onHand += x.onHand; kt.pallets += x.pallets; } });
      bodyHtml += `<div class="ps-compact-kho-light">${escHtml(currentKho)} &nbsp;&mdash;&nbsp; ${fmt(kt.onHand)} Pcs &middot; ${fmt(kt.pallets)} plt</div>`;
    }
    bodyHtml += `<div class="ps-compact-item">
      <div class="ps-ci-name"><b>📍 ${escHtml(g.locator)}</b> ${oqcBadge(g.oqc)}</div>
      <div class="ps-ci-qty">${fmt(g.onHand)} Pcs · ${fmt(g.pallets)} plt · ${fmtDec(g.cbm,2)} CBM</div>
    </div>`;
  });
  return bodyHtml;
}

function renderPickSlipBody(){
  const contentEl = document.getElementById('pick-slip-content');
  const slip = currentPickSlipData;
  if(!contentEl) return;
  if(!slip){
    contentEl.innerHTML = `<div style="padding:30px; text-align:center; color:#888;">Không tìm thấy container.</div>`;
    return;
  }
  const { row, grouped, shortages, totalOnHandWarehouse, totalCbmWarehouse } = slip;
  const totalPlanQty = [...new Map(grouped.map(g => [g.item + '||' + (g.po || ''), g.planQty])).values()].reduce((s, v) => s + v, 0);

  const shortageHtml = shortages.length
    ? `<div class="ps-shortage">⚠ THIẾU HÀNG — tồn PASS hiện có không đủ so với kế hoạch: ${shortages.map(s => `${escHtml(s.item)}${s.po ? ' (PO ' + escHtml(s.po) + ')' : ''} — thiếu ${fmt(s.missing)}`).join('; ')}</div>`
    : '';

  const totalPallet = grouped.reduce((s, g) => s + g.pallets, 0);
  const bodyHtml = pickSlipViewMode === 'locator' ? buildPickSlipBodyByLocatorCompact(grouped) : buildPickSlipBodyByItemCompact(grouped);
  contentEl.innerHTML = `
    ${buildPickSlipHeaderCompact(row)}
    ${bodyHtml}
    <div class="ps-compact-total"><span>Tổng cont (SL kế hoạch: ${fmt(totalPlanQty)})</span><span>${fmt(totalOnHandWarehouse)} Pcs · ${fmt(totalPallet)} plt · ${fmtDec(totalCbmWarehouse,2)} CBM</span></div>
    ${shortageHtml}
  `;

  const toggleBtn = document.getElementById('pick-slip-toggle-view');
  if(toggleBtn) toggleBtn.textContent = pickSlipViewMode === 'locator' ? '📦 Xem theo Mã hàng' : '📍 Xem theo Locator';
}

function togglePickSlipViewMode(){
  pickSlipViewMode = pickSlipViewMode === 'locator' ? 'item' : 'locator';
  renderPickSlipBody();
}

async function exportPickSlipExcel(){
  const slip = currentPickSlipData;
  if(!slip) return;
  if(!LIB_EXCELJS_OK){ alert('Không xuất được Excel: thư viện ExcelJS chưa tải được (cần Internet).'); return; }
  const { row, grouped, shortages, totalOnHandWarehouse, totalCbmWarehouse } = slip;
  const totalPlanQty = [...new Map(grouped.map(g => [g.item + '||' + (g.po || ''), g.planQty])).values()].reduce((s, v) => s + v, 0);
  const isLocatorMode = pickSlipViewMode === 'locator';
  const roundCbm = v => Math.round((v || 0) * 100) / 100;

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'TN5 Dashboard';
  workbook.created = new Date();
  const ws = workbook.addWorksheet('Goi y pick');
  ws.pageSetup = {
    paperSize: 9, orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0,
    horizontalCentered: true, margins: { left:0.3, right:0.3, top:0.4, bottom:0.4, header:0.2, footer:0.2 }
  };

  const headers = isLocatorMode
    ? ['#', 'Item (PO)', 'Locator', 'OQC', 'Tồn kho', 'SL pallet', 'CBM', 'Ghi chú']
    : ['#', 'Locator', 'OQC', 'Tồn kho', 'SL pallet', 'CBM'];
  const nCols = headers.length;
  const thin = { style:'thin', color:{ argb:'FFAAAAAA' } };
  const thick = { style:'medium', color:{ argb:'FF222222' } };
  const KHO_COLOR = 'FF2E7D63';
  const GROUP_COLOR = 'FF6E4FE0';
  const GROUP_COLOR_WARN = 'FFC9740A';

  let r = 1;
  const colMaxLen = headers.map(h => h.length);
  const trackWidth = (idx, text) => { const len = String(text==null?'':text).length; if(len > colMaxLen[idx]) colMaxLen[idx] = len; };

  const mergeFullRow = (text, opts) => {
    ws.mergeCells(r,1,r,nCols);
    const cell = ws.getCell(r,1);
    cell.value = text;
    cell.font = opts && opts.font || {};
    if(opts && opts.fill) cell.fill = { type:'pattern', pattern:'solid', fgColor:{ argb: opts.fill } };
    cell.alignment = opts && opts.alignment || { vertical:'middle' };
    if(opts && opts.border){
      for(let c=1;c<=nCols;c++) ws.getCell(r,c).border = opts.border(c);
    }
    if(opts && opts.height) ws.getRow(r).height = opts.height;
    r++;
  };
  const writeGroupHeaderRow = (label, fillColor) => {
    mergeFullRow(label, {
      font: { bold:true, color:{ argb:'FFFFFFFF' }, size:12 },
      fill: fillColor,
      alignment: { vertical:'middle', horizontal:'left', indent:1 },
      height: 20,
      border: (c) => ({ top:thick, bottom:thick, left: c===1?thick:thin, right: c===nCols?thick:thin })
    });
  };
  const writeMiniHeaderRow = () => {
    headers.forEach((h,i) => {
      const cell = ws.getCell(r, i+1);
      cell.value = h;
      cell.font = { bold:true };
      cell.fill = { type:'pattern', pattern:'solid', fgColor:{ argb:'FFEFEFEF' } };
      cell.alignment = { vertical:'middle', horizontal: i===1 ? 'left' : 'center' };
      cell.border = { top:thin, bottom:thick, left: i===0?thick:thin, right: i===nCols-1?thick:thin };
    });
    r++;
  };
  const writeDataRow = (values, opts) => {
    // opts.rightAlignIdx: chỉ số (0-based) các cột cần căn phải — mặc định "3 cột cuối" (Tồn kho/SL
    // pallet/CBM) chỉ đúng khi đó CHÍNH LÀ 3 cột cuối cùng; từ khi thêm cột "Ghi chú" ở CUỐI bảng
    // locator-mode, 3 cột cuối thật sự lại là SL pallet/CBM/Ghi chú (sai) — nên truyền rõ chỉ số cần
    // căn phải cho các trường hợp có thêm cột theo sau (xem lệnh gọi writeDataRow ở locator-mode).
    const rightAlignSet = (opts && opts.rightAlignIdx) ? new Set(opts.rightAlignIdx) : null;
    values.forEach((v,i) => {
      const cell = ws.getCell(r, i+1);
      cell.value = v;
      trackWidth(i, v);
      const isRight = rightAlignSet ? rightAlignSet.has(i) : (i >= values.length - 3);
      cell.alignment = { vertical:'middle', horizontal: isRight ? 'right' : (i===0 ? 'center' : 'left'), wrapText: i===1 };
      // opts.groupFirst (theo yêu cầu — "chỉnh phân locator bằng nét đậm cho dễ nhìn"): dòng ĐẦU TIÊN
      // của mỗi Locator mới (ở chế độ theo Locator) được viền TRÊN đậm — giống hệt cách đã làm để
      // phân biệt ranh giới giữa các Kho, giúp mắt lướt xuống bảng dễ nhận ra chỗ đổi Locator hơn.
      cell.border = { top: (opts && opts.groupFirst) ? thick : thin, bottom:thin, left: i===0?thick:thin, right: i===values.length-1?thick:thin };
      if(opts && opts.warn) cell.font = { bold:true, color:{ argb:'FFC9740A' } };
    });
    r++;
  };
  // Cột "Ghi chú" (locator-mode) nằm SAU cùng 3 cột số (Tồn kho/SL pallet/CBM) — writeSubtotalRow
  // trước đây giả định 3 cột số LUÔN là 3 cột cuối bảng, giờ không còn đúng nữa với locator-mode nên
  // phải trừ đi số cột "không phải số" nằm sau chúng khi tính vị trí đặt Tồn kho/SL pallet/CBM.
  const trailingNonNumCols = isLocatorMode ? 1 : 0;
  const writeSubtotalRow = (label, onHand, pallets, cbmVal, bold) => {
    const lastNumCol = nCols - trailingNonNumCols;
    ws.mergeCells(r,1,r,lastNumCol-3);
    const labelCell = ws.getCell(r,1);
    labelCell.value = label;
    labelCell.font = { bold:true, size: bold ? 11.5 : 10.5 };
    labelCell.alignment = { horizontal:'right', vertical:'middle' };
    const onHandCell = ws.getCell(r, lastNumCol-2);
    onHandCell.value = onHand; onHandCell.font = { bold:true };
    onHandCell.alignment = { horizontal:'right' };
    const palletCell = ws.getCell(r, lastNumCol-1);
    palletCell.value = pallets; palletCell.font = { bold:true };
    palletCell.alignment = { horizontal:'right' };
    const cbmCell = ws.getCell(r, lastNumCol);
    cbmCell.value = cbmVal; cbmCell.font = { bold:true };
    cbmCell.alignment = { horizontal:'right' };
    for(let c=1;c<=nCols;c++){
      ws.getCell(r,c).fill = { type:'pattern', pattern:'solid', fgColor:{ argb: bold ? 'FFEDEBFB' : 'FFF6F6F6' } };
      ws.getCell(r,c).border = { top: bold ? thick : thin, bottom:thick, left: c===1?thick:thin, right: c===nCols?thick:thin };
    }
    r++;
  };

  mergeFullRow(`GỢI Ý PICK HÀNG XUẤT CONT ${row.type}-${row.cNo}`, { font:{ bold:true, size:14 } });
  mergeFullRow(`Ngày load: ${row.loadDate}    Giờ plan: ${row.planTime}    CR: ${row.csr}    Invoice: ${row.invoice}`, { font:{ italic:true, color:{ argb:'FF666666' } } });
  r++;

  if(isLocatorMode){
    const sorted = grouped.slice().sort((a, b) => {
      const ka = PICK_SLIP_KHO_ORDER[a.kho] ?? 9, kb = PICK_SLIP_KHO_ORDER[b.kho] ?? 9;
      if(ka !== kb) return ka - kb;
      const walkCmp = comparePickWalkOrder(a, b);
      if(walkCmp !== 0) return walkCmp;
      return a.item.localeCompare(b.item);
    });
    // SỬA (theo yêu cầu): trước đây mỗi Locator có riêng 1 dòng tiêu đề màu cam + 1 dòng mini-header
    // lặp lại (# | Item (PO) | OQC | Tồn kho | SL pallet | CBM) — rất dài dòng khi có nhiều Locator,
    // đa số chỉ có 1 dòng dữ liệu bên dưới. Nay gộp Locator thành 1 CỘT dữ liệu bình thường ngay
    // trong bảng chính (như cột "Item (PO)"), chỉ còn 1 dòng mini-header MỖI KHO (không lặp lại theo
    // từng Locator nữa) — gọn hơn nhiều, vẫn giữ nguyên việc gộp/xếp theo Kho + đi theo đúng thứ tự
    // đường đi (comparePickWalkOrder).
    let currentKho = null, currentLocator = null;
    let khoOnHand = 0, khoPallet = 0, khoCbm = 0, stt = 0;
    sorted.forEach((g, i) => {
      if(g.kho !== currentKho){
        if(currentKho !== null) writeSubtotalRow('Tổng ' + currentKho, khoOnHand, khoPallet, roundCbm(khoCbm), true);
        currentKho = g.kho; currentLocator = null; khoOnHand = 0; khoPallet = 0; khoCbm = 0; stt = 0;
        writeGroupHeaderRow(currentKho, KHO_COLOR);
        writeMiniHeaderRow();
      }
      const isNewLocator = g.locator !== currentLocator;
      currentLocator = g.locator;
      stt++;
      khoOnHand += g.onHand; khoPallet += g.pallets; khoCbm += (g.cbm || 0);
      // Theo yêu cầu: phần "DƯ x (KH y)" trước đây nối thẳng vào cột "Item (PO)" — chuyển ra cột
      // "Ghi chú" riêng ở cuối bảng cho gọn, không làm dài dòng tên mã hàng.
      const itemLabel = g.item + (g.po ? ` (PO ${g.po})` : '') + (g.itemPoCount > 1 ? ` — Có ${g.itemPoCount} PO` : '');
      const noteText = g.isSurplus ? `DƯ ${g.surplusQty} (KH ${g.planQty})` : '';
      writeDataRow([stt, itemLabel, g.locator, g.oqc || '', g.onHand, g.pallets, roundCbm(g.cbm), noteText], { warn: g.isSurplus, groupFirst: isNewLocator, rightAlignIdx: [4,5,6] });
      if(i === sorted.length - 1){
        writeSubtotalRow('Tổng ' + currentKho, khoOnHand, khoPallet, roundCbm(khoCbm), true);
      }
    });
  } else {
    let currentKey = null, currentKho = null;
    let itemOnHand = 0, itemPallet = 0, itemCbm = 0, khoOnHand = 0, khoPallet = 0, khoCbm = 0, stt = 0;
    grouped.forEach((g, i) => {
      const key = g.item + '||' + (g.po || '');
      if(key !== currentKey){
        if(currentKey !== null){
          writeSubtotalRow('Tổng ' + currentKho, khoOnHand, khoPallet, roundCbm(khoCbm), true);
          writeSubtotalRow('Tổng mã này', itemOnHand, itemPallet, roundCbm(itemCbm), true);
        }
        currentKey = key; currentKho = null; itemOnHand = 0; itemPallet = 0; itemCbm = 0; stt = 0;
        const headerLabel = `Mã ${g.item} — PO ${g.po || '—'} (KH ${g.planQty})` + (g.itemPoCount > 1 ? ` — Có ${g.itemPoCount} PO` : '') + (g.isSurplus ? ` — ⚠ DƯ ${g.surplusQty}` : '');
        writeGroupHeaderRow(headerLabel, g.isSurplus ? GROUP_COLOR_WARN : GROUP_COLOR);
      }
      if(g.kho !== currentKho){
        if(currentKho !== null) writeSubtotalRow('Tổng ' + currentKho, khoOnHand, khoPallet, roundCbm(khoCbm), true);
        currentKho = g.kho; khoOnHand = 0; khoPallet = 0; khoCbm = 0;
        writeGroupHeaderRow(currentKho, KHO_COLOR);
        writeMiniHeaderRow();
      }
      stt++;
      itemOnHand += g.onHand; itemPallet += g.pallets; itemCbm += (g.cbm || 0);
      khoOnHand += g.onHand; khoPallet += g.pallets; khoCbm += (g.cbm || 0);
      writeDataRow([stt, g.locator, g.oqc || '', g.onHand, g.pallets, roundCbm(g.cbm)]);
      if(i === grouped.length - 1){
        writeSubtotalRow('Tổng ' + currentKho, khoOnHand, khoPallet, roundCbm(khoCbm), true);
        writeSubtotalRow('Tổng mã này', itemOnHand, itemPallet, roundCbm(itemCbm), true);
      }
    });
  }

  r++;
  writeSubtotalRow('SL kế hoạch (tổng)', totalPlanQty, '', '', true);
  writeSubtotalRow('TỔNG TỒN (tất cả mã)', totalOnHandWarehouse, '', roundCbm(totalCbmWarehouse), true);

  if(shortages.length){
    r++;
    mergeFullRow('⚠ THIẾU HÀNG', { font:{ bold:true, color:{ argb:'FFD6394B' } } });
    shortages.forEach(s => {
      mergeFullRow(`${s.item}${s.po ? ' (PO ' + s.po + ')' : ''} — thiếu ${s.missing}`, { font:{ color:{ argb:'FFD6394B' } }, alignment:{ vertical:'middle' } });
    });
  }

  // Tự căn chiều rộng cột theo nội dung thực tế (có giới hạn min/max cho từng cột) — tra theo TÊN cột
  // thay vì vị trí cố định, vì locator-mode và item-mode có số cột khác nhau (locator-mode có thêm
  // cột "Locator" từ bản sửa gộp locator vào bảng chính).
  const colCapsByHeader = {
    '#': [4,6], 'Item (PO)': [16,48], 'Locator': [10,16], 'OQC': [8,10],
    'Tồn kho': [10,14], 'SL pallet': [10,12], 'CBM': [8,10], 'Ghi chú': [12,24]
  };
  headers.forEach((h, i) => {
    const [minW, maxW] = colCapsByHeader[h] || [8,14];
    ws.getColumn(i+1).width = Math.min(Math.max(colMaxLen[i] + 2, minW), maxW);
  });

  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer], { type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stamp = fmtDateTime(new Date()).replace(/[/:]/g, '-').replace(/\s+/g, '_');
  a.href = url;
  a.download = `Goi_y_pick_${row.type}-${row.cNo}_${stamp}.xlsx`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function openPickSlip(type, cNo, instanceKey){
  renderPickSlipContent(type, cNo, instanceKey);
  const overlay = document.getElementById('pick-slip-overlay');
  if(overlay) overlay.classList.add('show');
}
function closePickSlip(){
  const overlay = document.getElementById('pick-slip-overlay');
  if(overlay) overlay.classList.remove('show');
}
const pickSlipCloseBtn = document.getElementById('pick-slip-close');
if(pickSlipCloseBtn) pickSlipCloseBtn.addEventListener('click', closePickSlip);
const pickSlipPrintBtn = document.getElementById('pick-slip-print');
if(pickSlipPrintBtn) pickSlipPrintBtn.addEventListener('click', exportPickSlipExcel);
const pickSlipToggleViewBtn = document.getElementById('pick-slip-toggle-view');
if(pickSlipToggleViewBtn) pickSlipToggleViewBtn.addEventListener('click', togglePickSlipViewMode);
const pickSlipOverlayEl = document.getElementById('pick-slip-overlay');
if(pickSlipOverlayEl) pickSlipOverlayEl.addEventListener('click', (e) => { if(e.target === pickSlipOverlayEl) closePickSlip(); });

/* ============ Màn hình kho — chỉ hiện container cần load HÔM NAY, chữ to cho xem trên điện thoại ============ */
const KIOSK_WEEKDAY_VI = ['Chủ nhật', 'Thứ 2', 'Thứ 3', 'Thứ 4', 'Thứ 5', 'Thứ 6', 'Thứ 7'];
function kioskTodayDDMMYYYY(){
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()}`;
}
function kioskParseTimeToMinutes(t){
  const m = String(t || '').match(/^(\d{1,2}):(\d{2})/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : 99999;
}

function renderKioskPage(){
  const listEl = document.getElementById('kiosk-list');
  const summaryEl = document.getElementById('kiosk-summary');
  const dateEl = document.getElementById('kiosk-date');
  if(!listEl) return;

  if(typeof renderContainerPickingOverview === 'function') renderContainerPickingOverview();

  const todayStr = kioskTodayDDMMYYYY();
  const now = new Date();
  if(dateEl) dateEl.textContent = `${KIOSK_WEEKDAY_VI[now.getDay()]}, ${todayStr}`;

  // Hiện ĐẦY ĐỦ container như bảng thống kê (không chỉ lọc riêng hôm nay) — sắp theo ngày giờ load
  // tăng dần, giống mặc định của bảng thống kê Picking Status.
  const todays = (contPickAllRows || [])
    .slice()
    .sort((a, b) => ovParseDateTimeSortKey(a.loadDate, a.planTime) - ovParseDateTimeSortKey(b.loadDate, b.planTime));

  const notStarted = todays.filter(r => r.status === 'notStarted').length;
  const inProgress = todays.filter(r => r.status === 'inProgress').length;
  const done = todays.filter(r => r.status === 'done').length;

  if(summaryEl){
    summaryEl.innerHTML = `
      <div class="kiosk-kpi"><div class="kiosk-kpi-val">${fmt(todays.length)}</div><div class="kiosk-kpi-label">TỔNG CONTAINER</div></div>
      <div class="kiosk-kpi bad"><div class="kiosk-kpi-val">${fmt(notStarted)}</div><div class="kiosk-kpi-label">CHƯA PICK</div></div>
      <div class="kiosk-kpi warn"><div class="kiosk-kpi-val">${fmt(inProgress)}</div><div class="kiosk-kpi-label">ĐANG PICK</div></div>
      <div class="kiosk-kpi good"><div class="kiosk-kpi-val">${fmt(done)}</div><div class="kiosk-kpi-label">PICK XONG</div></div>
    `;
  }

  if(!todays.length){
    listEl.innerHTML = `<div class="kiosk-empty">✓ Chưa có container nào trong Plan đã tải.</div>`;
    return;
  }

  const KIOSK_KHO_COLORS = {'Kho 2B':'#2C6FCB','Kho 3A':'#6E4FE0','Kho 3B':'#0E8F76','Kho DG1':'#B76E00'};
  listEl.innerHTML = todays.map(r => {
    const shortHtml = (r.shortItems && r.shortItems.length)
      ? `<div class="kiosk-card-warn">⚠ Thiếu ${fmt(r.shortItems.length)} mã: ${escHtml(r.shortItems.map(it => it.item).join(', '))}</div>`
      : '';
    const manualBtnLabel = r.isManual ? 'Bỏ đánh dấu' : 'Đánh dấu xong';
    const manualBtnIcon = r.isManual
      ? '<path d="M18 6 6 18"/><path d="M6 6l12 12"/>'
      : '<path d="M20 6 9 17l-5-5"/>';
    const khoColor = KIOSK_KHO_COLORS[r.topKho] || '#8A97AC';
    const cardBgStyle = ` style="background:${hexToRgba(khoColor, 0.22)};"`;
    return `<div class="kiosk-card lvl-${r.status}"${cardBgStyle}>
      <div class="kiosk-card-cont">${escHtml(r.type)}-${escHtml(String(r.cNo))}</div>
      <div class="kiosk-card-time"><div class="kiosk-card-loaddate">${escHtml(r.loadDate || '—')}</div>${escHtml(r.planTime)}</div>
      <div class="kiosk-card-status" style="color:${CONT_PICK_STATUS_COLOR[r.status]}">${CONT_PICK_STATUS_LABEL[r.status]} · ${r.pct.toFixed(0)}%${r.isManual ? ' <span style="color:var(--muted-2); font-weight:400; font-size:13px;">(tồn kho thực: ' + r.autoPct.toFixed(0) + '%)</span>' : ''}</div>
      <button type="button" class="kiosk-card-mark-btn${r.isManual ? ' marked' : ''}" data-mark-type="${escAttr(r.type)}" data-mark-cno="${escAttr(String(r.cNo))}" data-mark-loaddate="${escAttr(r.loadDateKey || '')}" data-mark-plantime="${escAttr(r.planTimeKey || '')}">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">${manualBtnIcon}</svg>
        ${manualBtnLabel}
      </button>
      <button type="button" class="kiosk-card-pick-btn" data-pick-type="${escAttr(r.type)}" data-pick-cno="${escAttr(String(r.cNo))}" data-pick-instance="${escAttr(r.instanceKey)}" title="Xem gợi ý pick hàng cho container này">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9V2h12v7"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>
        Gợi ý pick
      </button>
      <div class="kiosk-card-meta">Invoice: ${escHtml(r.invoice)} &nbsp;·&nbsp; CR: ${escHtml(r.csr)}${r.topKho ? ` &nbsp;·&nbsp; Kho nhiều hàng nhất: <b style="color:${khoColor};">${escHtml(r.topKho.replace('Kho ', ''))}</b>` : ''}</div>
      ${shortHtml}
    </div>`;
  }).join('');
}
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.kiosk-card-pick-btn');
  if(btn){ openPickSlip(btn.dataset.pickType, btn.dataset.pickCno, btn.dataset.pickInstance); return; }
  const markBtn = e.target.closest('.kiosk-card-mark-btn');
  if(markBtn) togglePickedManual(markBtn.dataset.markType, markBtn.dataset.markCno, markBtn.dataset.markLoaddate, markBtn.dataset.markPlantime);
});

const kioskRefreshBtn = document.getElementById('kiosk-refresh-btn');
if(kioskRefreshBtn) kioskRefreshBtn.addEventListener('click', async () => {
  kioskRefreshBtn.classList.add('spinning');
  try{
    if(typeof CloudVault !== 'undefined' && CloudVault.url && CloudVault.token){
      await CloudVault.readAll();
    }
    renderKioskPage();
  }catch(e){ console.warn('Làm mới Màn hình kho lỗi:', e); }
  finally{ kioskRefreshBtn.classList.remove('spinning'); }
});
// Tự làm mới mỗi 60 giây (không gọi mạng, chỉ vẽ lại từ dữ liệu hiện có) — phòng khi màn hình
// được để mở cả ngày ở khu vực kho mà không ai đụng vào.
setInterval(() => {
  const pageEl = document.getElementById('page-kiosk');
  if(pageEl && pageEl.style.display !== 'none') renderKioskPage();
}, 60000);


function fmtShortDate(isoDate){
  const parts = String(isoDate || '').split('-');
  return parts.length === 3 ? `${parts[2]}/${parts[1]}` : isoDate;
}

// Trả về [{date:'YYYY-MM-DD', pct}] cho 1 kho — cộng pallet mỗi ngày của đúng các locator đang
// được TÍNH vào Utilization của kho đó (giống hệt danh sách dùng ở panel "Tổng quan sức chứa" —
// mặc định hoặc đã tuỳ chỉnh riêng), chia cho sức chứa HIỆN TẠI của kho (giả định sức chứa ít
// đổi qua thời gian nên dùng chung 1 mốc cho cả chuỗi lịch sử là hợp lý).
function computeUtilizationTrendSeries(khoCode){
  const khoLabel = OV_KHO_LABELS[khoCode];
  const saved = ovMigrateCfgShape((ovLocatorConfig || {})[khoCode]);
  let capMap, capacity;
  if(saved){
    capMap = saved.locators;
    capacity = (saved.totalOverride !== null && saved.totalOverride !== undefined && saved.totalOverride !== '')
      ? Number(saved.totalOverride)
      : Object.keys(capMap).reduce((s,l) => s + (whApplyCapOverride(l, Number(capMap[l])||0)), 0);
  } else {
    capMap = ovDefaultCapMap(khoCode); // đã tự áp số ghi đè (bánh răng) bên trong
    capacity = Object.values(capMap).reduce((s,c) => s + c, 0);
  }
  const localSet = new Set(Object.keys(capMap));
  if(!capacity || !localSet.size) return [];

  const byDate = new Map();
  Object.keys(invSnapshotHistory).forEach(key => {
    const parts = key.split('||');
    if(parts.length < 3) return;
    const kho = parts[0], locator = parts.slice(2).join('||');
    if(kho !== khoLabel || !localSet.has(locator)) return;
    invSnapshotHistory[key].forEach(p => {
      if(typeof p.pallets !== 'number') return; // điểm cũ (trước khi có bản ghi pallet) -> bỏ qua
      byDate.set(p.date, (byDate.get(p.date) || 0) + p.pallets);
    });
  });

  return Array.from(byDate.keys()).sort().map(date => ({ date, pct: (byDate.get(date) / capacity) * 100 }));
}

function buildTrendChartSvg(seriesList){
  const width = 720, height = 220, padL = 38, padR = 14, padT = 14, padB = 26;
  const allDates = Array.from(new Set(seriesList.flatMap(s => s.points.map(p => p.date)))).sort();
  if(allDates.length < 2){
    return `<div class="wh3b-empty">Chưa đủ dữ liệu lịch sử để vẽ biểu đồ — mỗi ngày mở dashboard sẽ tự ghi thêm 1 điểm, cần ít nhất 2 ngày khác nhau mới vẽ được đường xu hướng.</div>`;
  }
  const maxPct = Math.max(100, ...seriesList.flatMap(s => s.points.map(p => p.pct)));
  const xFor = date => padL + (allDates.indexOf(date) / (allDates.length - 1)) * (width - padL - padR);
  const yFor = pct => padT + (1 - pct / maxPct) * (height - padT - padB);

  const gridVals = [0, 25, 50, 75, 100].filter(v => v <= maxPct + 0.01);
  const gridHtml = gridVals.map(v => `
    <line x1="${padL}" y1="${yFor(v).toFixed(1)}" x2="${width - padR}" y2="${yFor(v).toFixed(1)}" stroke="var(--line-soft)" stroke-width="1"/>
    <text x="${padL - 6}" y="${(yFor(v)+3).toFixed(1)}" font-size="9" text-anchor="end" fill="var(--muted-2)">${v}%</text>
  `).join('');

  const tickCount = Math.min(6, allDates.length);
  const tickIdx = Array.from({length: tickCount}, (_, i) => Math.round(i * (allDates.length - 1) / Math.max(1, tickCount - 1)));
  const uniqTickIdx = Array.from(new Set(tickIdx));
  const xTicksHtml = uniqTickIdx.map(i => `<text x="${xFor(allDates[i]).toFixed(1)}" y="${height - 8}" font-size="9" text-anchor="middle" fill="var(--muted-2)">${fmtShortDate(allDates[i])}</text>`).join('');

  const seriesHtml = seriesList.map(s => {
    if(s.points.length < 2) return '';
    const path = s.points.map((p, i) => `${i === 0 ? 'M' : 'L'}${xFor(p.date).toFixed(1)},${yFor(p.pct).toFixed(1)}`).join(' ');
    const dots = s.points.map(p => `<circle cx="${xFor(p.date).toFixed(1)}" cy="${yFor(p.pct).toFixed(1)}" r="2.6" fill="${s.color}"><title>${s.label} — ${p.date}: ${p.pct.toFixed(1)}%</title></circle>`).join('');
    return `<path d="${path}" fill="none" stroke="${s.color}" stroke-width="2.2"/>${dots}`;
  }).join('');

  return `<svg class="trend-chart-svg" viewBox="0 0 ${width} ${height}" style="width:100%; height:auto; max-height:260px; display:block;">
    ${gridHtml}
    ${seriesHtml}
    ${xTicksHtml}
  </svg>`;
}

const TREND_KHO_COLORS = { '3B': '#0E8F76', '3A': '#2C6FCB', '2B': '#F5A623' };

function renderUtilizationTrendChart(){
  const panel = document.getElementById('trend-chart-panel');
  const legendEl = document.getElementById('trend-legend');
  const wrapEl = document.getElementById('trend-chart-wrap');
  if(!panel || !wrapEl || !currentData) return;

  const seriesList = ['3B', '3A', '2B'].map(code => ({
    code, label: 'Kho ' + code, color: TREND_KHO_COLORS[code],
    points: computeUtilizationTrendSeries(code)
  })).filter(s => s.points.length);

  if(!seriesList.length){
    panel.style.display = 'none';
    return;
  }
  panel.style.display = '';

  if(legendEl){
    legendEl.innerHTML = seriesList.map(s => {
      const last = s.points[s.points.length - 1];
      return `<span><i style="background:${s.color}"></i>${escHtml(s.label)} — hiện ${last.pct.toFixed(1)}%</span>`;
    }).join('');
  }
  wrapEl.innerHTML = buildTrendChartSvg(seriesList);
}


function computeOverCapacityLocators(){
  const counts = ovBuildLocatorCounts();
  const results = [];
  ovB3FloorLocators().forEach(l => {
    const cap = whApplyCapOverride(l, ovB3Capacity(l));
    const q = counts.get(l) || 0;
    if(cap && q > cap) results.push({ kho: '3B', locator: l, qty: q, cap });
  });
  B2_LOCATORS.filter(l => !OV_B2_EXCLUDED.includes(l)).forEach(l => {
    const cap = whApplyCapOverride(l, B2_CAPACITY_MAP[l] || 0);
    const q = counts.get(l) || 0;
    if(cap && q > cap) results.push({ kho: '2B', locator: l, qty: q, cap });
  });
  ov3ARackLocators().forEach(l => {
    const cap = whApplyCapOverride(l, OV_3A_RACK_CAPACITY_PER_LOC);
    const q = counts.get(l) || 0;
    if(q > cap) results.push({ kho: '3A', locator: l, qty: q, cap });
  });
  ov3AFloorLocators().forEach(l => {
    const base = ov3AFloorCapacity(l);
    if(!base) return;
    const cap = whApplyCapOverride(l, base);
    const q = counts.get(l) || 0;
    if(q > cap) results.push({ kho: '3A', locator: l, qty: q, cap });
  });
  ov3AM1Locators().forEach(l => {
    const cap = whApplyCapOverride(l, OV_3A_M1_CAPACITY_PER_LOC);
    const q = counts.get(l) || 0;
    if(q > cap) results.push({ kho: '3A', locator: l, qty: q, cap });
  });
  return results;
}

function alertsJumpTo(pageId, callback){
  const navBtn = document.querySelector(`.sidebar-nav-btn[data-page="${pageId}"]`);
  if(navBtn && !navBtn.classList.contains('active')) navBtn.click();
  setTimeout(() => { if(callback) callback(); }, 90);
}
function alertsHighlightScroll(el){
  if(!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  const prevOutline = el.style.outline, prevOffset = el.style.outlineOffset;
  el.style.outline = '3px solid var(--amber-bright)';
  el.style.outlineOffset = '2px';
  setTimeout(() => { el.style.outline = prevOutline; el.style.outlineOffset = prevOffset; }, 1800);
}

function renderAlertsPanel(){
  const panel = document.getElementById('alerts-panel');
  const summaryEl = document.getElementById('alerts-summary');
  const gridEl = document.getElementById('alerts-grid');
  if(!panel || !gridEl || !currentData) return;

  const cards = [];

  // 1) Hàng NG theo từng kho
  ['3B', '3A', '2B'].forEach(code => {
    const s = ovGetNgSummaryForKho(code);
    if(s.rows.length){
      const distinctCodes = new Set(s.rows.map(r => r.item + '||' + r.custpo)).size;
      cards.push({
        count: distinctCodes,
        title: `Hàng NG — Kho ${code}`,
        desc: `${fmt(distinctCodes)} mã + PO · ${fmt(s.totalNgPallets)} pallet`,
        onClick: () => alertsJumpTo('overview', () => {
          const secEl = document.getElementById('ov-ng-section-' + code);
          if(secEl && typeof ccSetCollapsePanelOpen === 'function') ccSetCollapsePanelOpen(secEl, true);
          alertsHighlightScroll(secEl);
        })
      });
    }
  });

  // 2) Vượt sức chứa
  const over = computeOverCapacityLocators();
  if(over.length){
    const byKho = {};
    over.forEach(o => { byKho[o.kho] = (byKho[o.kho] || 0) + 1; });
    Object.keys(byKho).forEach(code => {
      cards.push({
        count: byKho[code],
        title: `Vượt sức chứa — Kho ${code}`,
        desc: `${fmt(byKho[code])} vị trí đang chứa nhiều hơn sức chứa chuẩn`,
        onClick: () => alertsJumpTo('overview', () => alertsHighlightScroll(document.getElementById('ov-block-' + code)))
      });
    });
  }

  // 3) Thiếu hàng / PO không khớp theo Plan
  if(PLAN_TYPES.some(t => planData[t])){
    const combined = buildCombinedPlanCompareTable();
    if(combined.shortCount){
      cards.push({
        count: combined.shortCount,
        title: 'Thiếu hàng theo kế hoạch xuất cont',
        desc: `${fmt(combined.shortCount)} mã + PO có tồn kho (PASS) thấp hơn SL kế hoạch`,
        onClick: () => alertsJumpTo('picking', () => alertsHighlightScroll(document.getElementById('plan-combined-row')))
      });
    }
    if(combined.poMismatchCount){
      cards.push({
        count: combined.poMismatchCount,
        title: 'PO không khớp tồn kho',
        desc: `${fmt(combined.poMismatchCount)} PO trong kế hoạch không thấy đúng PO trong tồn kho`,
        onClick: () => alertsJumpTo('picking', () => alertsHighlightScroll(document.getElementById('plan-combined-row')))
      });
    }
  }

  // 4) Container thiếu hàng để pick
  if(typeof renderContainerPickingOverview === 'function') renderContainerPickingOverview();
  const shortContainers = (contPickAllRows || []).filter(r => r.shortItems && r.shortItems.length);
  if(shortContainers.length){
    const totalShortItems = shortContainers.reduce((s, r) => s + r.shortItems.length, 0);
    cards.push({
      count: shortContainers.length,
      title: 'Container thiếu hàng để pick',
      desc: `${fmt(shortContainers.length)} container · ${fmt(totalShortItems)} lượt mã thiếu`,
      onClick: () => alertsJumpTo('picking', () => alertsHighlightScroll(document.getElementById('cont-picking-overview')))
    });
  }

  // 5) Locator ngoài sơ đồ (Kho 3B)
  if(typeof renderSodo3bBlocks === 'function') renderSodo3bBlocks();
  if(sodo3bOutsideData && sodo3bOutsideData.locators && sodo3bOutsideData.locators.length){
    cards.push({
      count: sodo3bOutsideData.locators.length,
      title: 'Locator ngoài sơ đồ kho 3B',
      desc: `${fmt(sodo3bOutsideData.locators.length)} vị trí · ${fmt(sodo3bOutsideData.rows.length)} pallet chưa có trong sơ đồ`,
      onClick: () => alertsJumpTo('sodo3b', () => alertsHighlightScroll(document.getElementById('wh3b-outside-warning')))
    });
  }

  if(!cards.length){
    panel.style.display = 'none';
    gridEl.innerHTML = '';
    return;
  }
  panel.style.display = '';
  const totalIssues = cards.reduce((s, c) => s + c.count, 0);
  if(summaryEl) summaryEl.innerHTML = `<b>${fmt(cards.length)}</b> nhóm vấn đề · <b>${fmt(totalIssues)}</b> mục cần chú ý — bấm vào từng thẻ để xem chi tiết`;

  gridEl.innerHTML = '';
  cards.forEach(c => {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'alert-card';
    card.innerHTML = `
      <span class="alert-icon">${fmt(c.count)}</span>
      <span class="alert-body">
        <span class="alert-title">${escHtml(c.title)}</span>
        <span class="alert-desc">${escHtml(c.desc)}</span>
      </span>`;
    card.addEventListener('click', c.onClick);
    gridEl.appendChild(card);
  });
}

// ============ TOP mã hàng nhiều pallet nhất (trang Tìm mã hàng) ============
// Gộp theo Kho + Item No. — mỗi dòng dữ liệu gốc (raw_rows, tương ứng 1 GI No.) tính là 1 pallet,
// giống hệt quy ước đang dùng ở Sơ đồ kho 3B. Xếp hạng RIÊNG theo từng kho (hạng 1 = nhiều pallet
// nhất CỦA ĐÚNG KHO ĐÓ, không so lẫn giữa các kho khác nhau).
function computeTopPalletByItem(){
  const rows = [];
  if(!currentData) return rows;
  const raw = getRawRows(currentData);
  const map = new Map(); // 'kho||item' -> { count: số pallet, qty: tổng SL, hasNG: có dòng NG không }
  raw.forEach(r => {
    const kho = r[RAW_KEY_IDX.kho], item = r[RAW_KEY_IDX.item];
    if(!kho || !item) return;
    const key = kho + '||' + item;
    const qty = Number(r[RAW_KEY_IDX.qty]) || 0;
    const isNG = String(r[RAW_KEY_IDX.oqc] || '').toUpperCase() === 'NG';
    const cur = map.get(key);
    if(cur){ cur.count++; cur.qty += qty; if(isNG) cur.hasNG = true; }
    else map.set(key, { count:1, qty, hasNG: isNG });
  });
  map.forEach((v, key) => {
    const idx = key.indexOf('||');
    rows.push({ kho: key.slice(0, idx), item: key.slice(idx + 2), count: v.count, qty: v.qty, hasNG: v.hasNG });
  });
  const khoOrder = (currentData.kho_order && currentData.kho_order.length) ? currentData.kho_order : ['Kho 2B','Kho 3A','Kho 3B','Kho DG1'];
  rows.sort((a, b) => {
    const oa = khoOrder.indexOf(a.kho), ob = khoOrder.indexOf(b.kho);
    const ia = oa === -1 ? 999 : oa, ib = ob === -1 ? 999 : ob;
    if(ia !== ib) return ia - ib;
    return b.count - a.count;
  });
  let lastKho = null, rank = 0;
  rows.forEach(r => {
    if(r.kho !== lastKho){ lastKho = r.kho; rank = 0; }
    rank++;
    r.rank = rank;
  });
  return rows;
}
let _topPalletCache = [];
// Chỉ tính lại (group-by trên toàn bộ dữ liệu) khi dữ liệu tồn kho THẬT SỰ thay đổi — gọi từ
// renderKhoSearchPage() bên dưới. Lọc theo kho/mã hàng (gõ phím) chỉ lọc lại mảng đã tính sẵn,
// KHÔNG tính lại group-by mỗi lần gõ, xem renderTopPalletFiltered().
function renderTopPalletTable(){
  _topPalletCache = currentData ? computeTopPalletByItem() : [];
  renderTopPalletFiltered();
}
function renderTopPalletFiltered(){
  const tbody = document.getElementById('top-pallet-tbody');
  if(!tbody) return;
  const emptyEl = document.getElementById('top-pallet-empty');
  const table = document.getElementById('top-pallet-table');
  const summaryEl = document.getElementById('top-pallet-summary');
  const khoFilterEl = document.getElementById('top-pallet-kho-filter');
  const itemSearchEl = document.getElementById('top-pallet-item-search');

  if(khoFilterEl){
    const khoOrder = (currentData && currentData.kho_order && currentData.kho_order.length) ? currentData.kho_order : ['Kho 2B','Kho 3A','Kho 3B','Kho DG1'];
    const signature = khoOrder.join('|');
    if(khoFilterEl.dataset.builtFor !== signature){
      const cur = khoFilterEl.value;
      khoFilterEl.innerHTML = ['<option value="">Tất cả kho</option>'].concat(khoOrder.map(k => `<option value="${escAttr(k)}">${escHtml(k)}</option>`)).join('');
      khoFilterEl.value = cur;
      khoFilterEl.dataset.builtFor = signature;
    }
  }

  const khoFilter = khoFilterEl ? khoFilterEl.value : '';
  const itemQuery = removeDiacritics((itemSearchEl ? itemSearchEl.value : '').toLowerCase().trim());
  let rows = _topPalletCache;
  if(khoFilter) rows = rows.filter(r => r.kho === khoFilter);
  if(itemQuery) rows = rows.filter(r => removeDiacritics(r.item.toLowerCase()).includes(itemQuery));

  if(!rows.length){
    tbody.innerHTML = '';
    if(table) table.style.display = 'none';
    if(emptyEl) emptyEl.style.display = '';
    if(summaryEl) summaryEl.textContent = currentData ? '0 dòng' : 'Chưa có dữ liệu tồn kho';
    return;
  }
  if(table) table.style.display = '';
  if(emptyEl) emptyEl.style.display = 'none';
  if(summaryEl) summaryEl.textContent = `${fmt(rows.length)} dòng`;
  const medal = r => r.rank === 1 ? '🥇 ' : (r.rank === 2 ? '🥈 ' : (r.rank === 3 ? '🥉 ' : ''));
  tbody.innerHTML = rows.map(r => `<tr>
    <td>${medal(r)}${r.rank}</td>
    <td class="col-kho">${escHtml(r.kho.replace('Kho ',''))}</td>
    <td>${escHtml(r.item)}${r.hasNG ? ' <span class="oqc-badge ng" title="Có pallet OQC = NG trong mã này">NG</span>' : ''}</td>
    <td style="text-align:right">${fmt(r.count)}</td>
    <td style="text-align:right">${fmt(r.qty)}</td>
    <td style="text-align:center"><button type="button" class="btn-update btn-ghost-outline top-pallet-loc-btn" data-kho="${escAttr(r.kho)}" data-item="${escAttr(r.item)}" title="Xem vị trí của mã này trong kho này" style="padding:4px 8px;">📍</button></td>
  </tr>`).join('');
}
const topPalletKhoFilterEl = document.getElementById('top-pallet-kho-filter');
if(topPalletKhoFilterEl) topPalletKhoFilterEl.addEventListener('change', renderTopPalletFiltered);
const topPalletItemSearchEl = document.getElementById('top-pallet-item-search');
if(topPalletItemSearchEl) topPalletItemSearchEl.addEventListener('input', renderTopPalletFiltered);

// Gộp theo Locator — dùng khi bấm nút 📍 ở 1 dòng trong bảng "TOP mã hàng nhiều pallet nhất", cho
// biết đúng mã hàng đó, đúng kho đó, đang nằm ở những locator nào, mỗi locator bao nhiêu pallet và
// bao nhiêu SL (Pcs).
function computeLocatorBreakdown(kho, item){
  const rows = [];
  if(!currentData) return rows;
  const raw = getRawRows(currentData);
  const map = new Map(); // 'locator||oqc' -> { locator, oqc, pallet, qty } — tách riêng theo OQC vì
  // 1 locator có thể vừa có pallet PASS vừa có pallet NG của cùng 1 mã hàng, không được gộp lẫn.
  raw.forEach(r => {
    if(r[RAW_KEY_IDX.kho] !== kho || r[RAW_KEY_IDX.item] !== item) return;
    const locator = r[RAW_KEY_IDX.locator] || '(không rõ locator)';
    const oqc = r[RAW_KEY_IDX.oqc] || '';
    const qty = Number(r[RAW_KEY_IDX.qty]) || 0;
    const key = locator + '||' + oqc;
    const cur = map.get(key);
    if(cur){ cur.pallet++; cur.qty += qty; }
    else map.set(key, { locator, oqc, pallet:1, qty });
  });
  map.forEach(v => rows.push(v));
  rows.sort((a,b) => b.pallet - a.pallet);
  return rows;
}
function openTopPalletLocatorOverlay(kho, item){
  const titleEl = document.getElementById('top-pallet-locator-title');
  const contentEl = document.getElementById('top-pallet-locator-content');
  const overlay = document.getElementById('top-pallet-locator-overlay');
  if(!contentEl || !overlay) return;
  if(titleEl) titleEl.textContent = `📍 Vị trí — ${item} (${kho})`;
  const rows = computeLocatorBreakdown(kho, item);
  if(!rows.length){
    contentEl.innerHTML = `<div style="text-align:center; color:var(--muted-2); font-style:italic; padding:24px 0;">Không tìm thấy dòng nào — có thể dữ liệu tồn kho vừa được cập nhật lại.</div>`;
  } else {
    const totalPallet = rows.reduce((s,r) => s + r.pallet, 0);
    const totalQty = rows.reduce((s,r) => s + r.qty, 0);
    contentEl.innerHTML = `<table class="kho-detail-table"><thead><tr><th>Locator</th><th>OQC</th><th style="text-align:right">Số pallet</th><th style="text-align:right">Số lượng</th></tr></thead><tbody>
      ${rows.map(r => `<tr><td>${escHtml(r.locator)}</td><td>${oqcBadge(r.oqc)}</td><td style="text-align:right">${fmt(r.pallet)}</td><td style="text-align:right">${fmt(r.qty)}</td></tr>`).join('')}
    </tbody><tfoot><tr style="font-weight:700; border-top:2px solid var(--line);"><td>Tổng</td><td></td><td style="text-align:right">${fmt(totalPallet)}</td><td style="text-align:right">${fmt(totalQty)}</td></tr></tfoot></table>`;
  }
  overlay.classList.add('show');
}
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.top-pallet-loc-btn');
  if(btn) openTopPalletLocatorOverlay(btn.dataset.kho, btn.dataset.item);
});
const topPalletLocatorCloseBtn = document.getElementById('top-pallet-locator-close');
if(topPalletLocatorCloseBtn) topPalletLocatorCloseBtn.addEventListener('click', () => {
  const overlay = document.getElementById('top-pallet-locator-overlay');
  if(overlay) overlay.classList.remove('show');
});

function renderKhoSearchPage(){
  if(searchCtrlMain) searchCtrlMain.renderKhoSearchPage();
  if(searchCtrlKiemTon) searchCtrlKiemTon.renderKhoSearchPage();
  if(typeof ccRefreshLocatorCardsIfActive === 'function') ccRefreshLocatorCardsIfActive();
  renderSodo3B();
  if(typeof renderAlertsPanel === 'function') renderAlertsPanel();
  renderTopPalletTable();
}

// Hàm render bảng "Danh sách đã xác nhận"
function renderConfirmedList(){
  const confirmTbody = document.getElementById('confirmed-detail-tbody');
  const confirmEmpty = document.getElementById('confirmed-empty');
  if(!confirmTbody) return;

  const keys = Object.keys(confirmedKiemTonItems);
  if(!keys.length){
    confirmTbody.innerHTML = '';
    if(confirmEmpty) confirmEmpty.style.display = 'block';
    return;
  }
  if(confirmEmpty) confirmEmpty.style.display = 'none';

  const rows = keys.map(key => {
    const item = confirmedKiemTonItems[key];
    // Tính toán lại kết quả để hiển thị chính xác
    const total = (parseFloat(item.inputs[0]) || 0) * (parseFloat(item.inputs[1]) || 1) +
                  (parseFloat(item.inputs[2]) || 0) * (parseFloat(item.inputs[3]) || 1) +
                  (parseFloat(item.inputs[4]) || 0) * (parseFloat(item.inputs[5]) || 1);
    const calcStr = `(${fmt(item.inputs[0])}×${fmt(item.inputs[1])}) + (${fmt(item.inputs[2])}×${fmt(item.inputs[3])}) + (${fmt(item.inputs[4])}×${fmt(item.inputs[5])})`;
    return `
    <tr>
      <td>${item.data.kho.replace('Kho ','')}</td>
      <td>${item.data.item}</td>
      <td>${item.data.custpo}</td>
      <td>${item.data.locator}</td>
      <td>${oqcBadge(item.data.oqc)}</td>
      <td class="num">${fmt(item.data.qty)}</td>
      <td style="font-size:10px; text-align:center; font-family:var(--mono); color:var(--muted-2);">${calcStr}</td>
      <td class="num" style="color:var(--violet); font-weight:700;">${Math.round(total).toLocaleString('en-US')}</td>
      <td>${(() => {
        const parts = [];
        if(item.data.isWrongLocation) parts.push(`Vị trí ${escHtml(item.data.wmsLocator || '—')}`);
        if(item.data.isWrongOqc) parts.push(`OQC ${escHtml(item.data.wmsOqc || '—')}`);
        return parts.length ? `<span class="scanned-extra-badge" title="Thông tin hệ thống WMS ghi nhận cho mã này">⚠ WMS: ${parts.join(' · ')}</span>` : '—';
      })()}</td>
      <td style="text-align:center;">
        <button type="button" class="cki-restore-btn" data-restore-key="${escAttr(key)}" title="Lỡ nhập sai — khôi phục dòng này về bảng Kiểm tồn kho để nhập lại">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10"/><path d="M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
        </button>
      </td>
    </tr>`;
  }).join('');
  confirmTbody.innerHTML = rows;
  renderConfirmedExportButtons();
}

// Khôi phục 1 dòng đã xác nhận (lỡ nhập sai) — xoá khỏi "Đã xác nhận" và trả dòng đó về bảng
// "Kiểm tồn kho" với đúng số liệu đã nhập trước đó (không bị reset về 0) để nhập lại kết quả.
// "Bia mộ" (tombstone) các rowKey vừa bị xoá khỏi confirmedKiemTonItems bằng thao tác Khôi phục —
// BẮT BUỘC phải nhớ việc XOÁ này, vì bước "gộp dữ liệu Cloud" khi bấm Lưu (mergeConfirmedDataFromCloud)
// chỉ biết CỘNG THÊM những gì Cloud có mà máy này chưa có — nếu không loại trừ các key vừa khôi phục,
// nó sẽ vô tình "hồi sinh" lại đúng dòng vừa khôi phục (vì Cloud vẫn còn giữ bản CŨ, chưa kịp cập nhật
// bản đã xoá) — đây chính là lỗi "khôi phục xong bấm Lưu lại thấy dòng đó quay về".
let _restoredConfirmedKeys = new Set();
// "Bia mộ" cho các GI No. VỪA bị xoá (xoá 1 dòng đề xuất kiểm, hoặc bấm "Xoá lịch sử quét") — cùng lý
// do với _restoredConfirmedKeys ở trên, dùng ở mergeConfirmedDataFromCloud để không bị Cloud (chưa
// kịp cập nhật bản đã xoá) làm GI đó "hồi sinh" lại ngay khi Lưu/Làm mới dữ liệu.
let _deletedGiKeys = new Set();
function restoreConfirmedItem(rowKey){
  const entry = confirmedKiemTonItems[rowKey];
  if(!entry) return;
  const ok = confirm(`Khôi phục dòng "${entry.data.item}" (${entry.data.locator}) về bảng Kiểm tồn kho để nhập lại kết quả?`);
  if(!ok) return;
  ktInputValues[rowKey] = entry.inputs;
  delete confirmedKiemTonItems[rowKey];
  _restoredConfirmedKeys.add(rowKey);
  saveStateToStorage();
  renderKhoSearchPage(); // hiện lại dòng ở bảng Kiểm tồn kho, giữ nguyên số liệu đã nhập trước đó
  renderConfirmedList(); // ẩn dòng khỏi bảng Đã xác nhận
  // Đẩy NGAY việc khôi phục lên Cloud — càng đẩy sớm càng thu hẹp khoảng thời gian có thể xảy ra
  // tình huống "Cloud vẫn còn giữ bản cũ" (xem _restoredConfirmedKeys ở mergeConfirmedDataFromCloud).
  scheduleAutoSaveToCloud('confirm', [STORAGE_KEY_CONFIRMED, STORAGE_KEY_KT_INPUTS, STORAGE_KEY_LASTCHECK], 'Khôi phục dòng đã xác nhận');
}
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.cki-restore-btn');
  if(!btn) return;
  restoreConfirmedItem(btn.dataset.restoreKey);
});

// ============ Nhật ký thông báo (chuông) — ghi lại TẤT CẢ thông báo trạng thái kèm ngày giờ ============
// Chỉ lưu trong phiên làm việc hiện tại (mất khi tải lại trang) — không đồng bộ Cloud.
let notificationLog = []; // { time: Date, text, type }
let notifUnreadCount = 0;
const NOTIF_LOG_MAX = 80;

function logNotification(text, type){
  if(!text) return;
  // Tránh ghi trùng lặp liên tiếp y hệt nhau (VD: cùng 1 dòng trạng thái được set lại nhiều lần)
  if(notificationLog[0] && notificationLog[0].text === text && (Date.now() - notificationLog[0].time.getTime()) < 800) return;
  notificationLog.unshift({ time: new Date(), text, type: type || 'info' });
  if(notificationLog.length > NOTIF_LOG_MAX) notificationLog.length = NOTIF_LOG_MAX;
  notifUnreadCount++;
  updateNotifBadge();
  const panel = document.getElementById('notif-panel');
  if(panel && panel.style.display !== 'none') renderNotifPanel();
}

function updateNotifBadge(){
  const badge = document.getElementById('notif-badge');
  if(!badge) return;
  if(notifUnreadCount > 0){
    badge.textContent = notifUnreadCount > 99 ? '99+' : String(notifUnreadCount);
    badge.style.display = 'flex';
  } else {
    badge.style.display = 'none';
  }
}

function fmtNotifTime(d){
  const p = n => String(n).padStart(2,'0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} · ${p(d.getDate())}/${p(d.getMonth()+1)}`;
}

function renderNotifPanel(){
  const listEl = document.getElementById('notif-list');
  if(!listEl) return;
  if(!notificationLog.length){
    listEl.innerHTML = `<div style="text-align:center; color:var(--muted-2); font-style:italic; padding:20px 0;">Chưa có thông báo nào trong phiên này.</div>`;
    return;
  }
  listEl.innerHTML = notificationLog.map(n => `
    <div class="notif-item notif-${n.type}">
      <div class="notif-item-time">${fmtNotifTime(n.time)}</div>
      <div class="notif-item-text">${escHtml(n.text)}</div>
    </div>`).join('');
}

// Theo dõi mọi thay đổi nội dung của các dòng trạng thái chính trong app (upload/cloud/sync...) và
// TỰ ĐỘNG ghi vào nhật ký thông báo — không cần sửa từng chỗ hiện thông báo rải rác khắp nơi.
function watchStatusElForNotif(id){
  const el = document.getElementById(id);
  if(!el || typeof MutationObserver === 'undefined') return;
  let lastText = el.textContent;
  const obs = new MutationObserver(() => {
    const text = el.textContent.trim();
    if(!text || text === lastText) return;
    lastText = text;
    const type = el.classList.contains('err') ? 'error' : (el.classList.contains('ok') ? 'success' : 'info');
    logNotification(text, type);
  });
  obs.observe(el, { childList: true, characterData: true, subtree: true });
}
['upload-status', 'cv-status', 'fv-status'].forEach(watchStatusElForNotif);

document.addEventListener('click', (e) => {
  const toggle = e.target.closest('#notif-bell-btn');
  const panel = document.getElementById('notif-panel');
  if(toggle){
    if(panel){
      const willShow = panel.style.display === 'none';
      if(willShow){ renderNotifPanel(); notifUnreadCount = 0; updateNotifBadge(); }
      panel.style.display = willShow ? 'flex' : 'none';
    }
    return;
  }
  if(panel && panel.style.display !== 'none' && !e.target.closest('#notif-panel') && !e.target.closest('#notif-bell-btn')){
    panel.style.display = 'none';
  }
});

// Thông báo nổi nhỏ, tự ẩn sau vài giây — dùng chung cho các thao tác lưu/xoá.
let appToastTimer = null;
function showAppToast(text){
  logNotification(text, 'success');
  const el = document.getElementById('app-toast');
  if(!el) return;
  el.textContent = text;
  el.style.display = 'block';
  if(appToastTimer) clearTimeout(appToastTimer);
  appToastTimer = setTimeout(() => { el.style.display = 'none'; }, 4000);
}

function todayDMY(){
  const p = n => String(n).padStart(2,'0');
  const d = new Date();
  return `${p(d.getDate())}/${p(d.getMonth()+1)}/${d.getFullYear()}`;
}

// Dành riêng cho lịch sử "Đã lưu theo ngày": ca đêm chạy 19h hôm nay -> 7h sáng hôm sau, nên dùng
// NGÀY LỊCH thường ("hôm nay") sẽ bị SAI ngay sau nửa đêm — lúc đó ngày lịch đã tự nhảy sang hôm sau
// dù vẫn đang trong ĐÚNG 1 CA làm việc bắt đầu từ tối hôm trước, làm kết quả kiểm nửa đầu ca (trước
// 0h) và nửa sau ca (sau 0h) bị TÁCH thành 2 ngày khác nhau trong lịch sử, trong khi lẽ ra phải gộp
// chung 1 ngày (đúng ngày ca ĐÓ bắt đầu). Quy ước: bất kỳ lúc nào TRƯỚC 12h TRƯA đều tính là còn
// thuộc ca đêm bắt đầu từ TỐI HÔM TRƯỚC (vì ca đêm luôn kết thúc trước 7h sáng, không bao giờ kéo
// dài tới trưa) — lùi lại đúng 1 ngày lịch để khớp đúng ngày ca đó thực sự bắt đầu.
function shiftDateDMY(){
  const p = n => String(n).padStart(2,'0');
  const d = new Date();
  if(d.getHours() < 12) d.setDate(d.getDate() - 1);
  return `${p(d.getDate())}/${p(d.getMonth()+1)}/${d.getFullYear()}`;
}

// So sánh 2 ngày dạng "dd/mm/yyyy" — trả về số để sort (mới nhất trước)
function dmyToSortKey(dmy){
  const [d,m,y] = dmy.split('/').map(Number);
  return y*10000 + m*100 + d;
}

// Bấm nút "Lưu": chụp lại toàn bộ "Danh sách đã xác nhận" hiện tại vào lịch sử theo ngày, rồi làm
// mới (xoá trắng) bảng để bắt đầu đợt kiểm mới — các dòng vừa lưu cũng được mở khoá lại ở bảng
// Kiểm tồn kho / Đề xuất kiểm hôm nay (giống hệt nút "Đặt lại"), chỉ khác là có lưu trữ lại trước.
// Gộp dữ liệu "nhạy cảm khi nhiều người cùng dùng song song" (Đã xác nhận, số liệu KT đang nhập dở,
// GI đã quét, lịch sử theo ngày) từ bản Cloud MỚI NHẤT vào dữ liệu đang có trong máy — TRƯỚC khi ghi
// đè lên Cloud. Nhờ vậy nhiều người cùng bấm "LƯU" gần nhau (mỗi người kiểm 1 phần khác nhau) sẽ
// không xoá mất phần của nhau nữa, vì phần đã có trên Cloud luôn được giữ lại (gộp thêm, không đè).
function mergeConfirmedDataFromCloud(cloudData){
  if(!cloudData) return;

  try{
    const cloudConfirmed = cloudData[STORAGE_KEY_CONFIRMED] ? JSON.parse(cloudData[STORAGE_KEY_CONFIRMED], jsonReviver) : {};
    // Loại bỏ những dòng VỪA bị xoá bằng "Khôi phục" ở máy này khỏi bản Cloud trước khi gộp — nếu
    // không, Cloud (chưa kịp cập nhật bản đã xoá) sẽ làm dòng đó "hồi sinh" lại ngay khi Lưu.
    _restoredConfirmedKeys.forEach(k => delete cloudConfirmed[k]);
    confirmedKiemTonItems = Object.assign({}, cloudConfirmed, confirmedKiemTonItems);
  }catch(e){ console.warn('Không gộp được confirmedKiemTonItems từ Cloud:', e); }

  try{
    const cloudKt = cloudData[STORAGE_KEY_KT_INPUTS] ? JSON.parse(cloudData[STORAGE_KEY_KT_INPUTS]) : {};
    ktInputValues = Object.assign({}, cloudKt, ktInputValues);
  }catch(e){ console.warn('Không gộp được ktInputValues từ Cloud:', e); }

  try{
    const cloudGi = cloudData[STORAGE_KEY_SCANNED_GI] ? JSON.parse(cloudData[STORAGE_KEY_SCANNED_GI]) : [];
    // Loại bỏ những GI VỪA bị xoá (xoá 1 dòng, hoặc bấm "Xoá lịch sử quét") ở máy này khỏi bản Cloud
    // trước khi gộp — nếu không, Cloud (chưa kịp cập nhật bản đã xoá) sẽ làm GI đó "hồi sinh" lại ngay
    // khi Lưu, y hệt lỗi đã gặp với "Khôi phục" dòng đã xác nhận (xem _restoredConfirmedKeys).
    cloudGi.forEach(g => { if(!_deletedGiKeys.has(g)) scannedGiSet.add(g); });
  }catch(e){ console.warn('Không gộp được scannedGiSet từ Cloud:', e); }

  try{
    const cloudGiLog = cloudData[STORAGE_KEY_GI_LOG] ? JSON.parse(cloudData[STORAGE_KEY_GI_LOG]) : [];
    const existingGis = new Set(giScanLog.map(g => g.gi));
    cloudGiLog.forEach(g => { if(!existingGis.has(g.gi) && !_deletedGiKeys.has(g.gi)){ giScanLog.push(g); existingGis.add(g.gi); } });
  }catch(e){ console.warn('Không gộp được giScanLog từ Cloud:', e); }

  try{
    // Thư viện CBM: mỗi mã hàng gộp riêng theo mốc updatedAt mới nhất — mã nào Cloud có bản MỚI HƠN
    // (do máy khác vừa tải Plan cập nhật) thì lấy theo Cloud; mã nào máy này có bản mới hơn thì giữ
    // nguyên. Không dùng kiểu "toàn bộ ghi đè" vì đây là thư viện GÓP DẦN qua nhiều Plan/nhiều máy.
    const cloudItemCbm = cloudData[STORAGE_KEY_ITEM_CBM] ? JSON.parse(cloudData[STORAGE_KEY_ITEM_CBM]) : {};
    Object.entries(cloudItemCbm).forEach(([item, entry]) => {
      const local = itemCbmLibrary[item];
      if(!local || (entry && entry.updatedAt && (!local.updatedAt || entry.updatedAt > local.updatedAt))){
        itemCbmLibrary[item] = entry;
      }
    });
  }catch(e){ console.warn('Không gộp được thư viện CBM từ Cloud:', e); }

  try{
    const cloudHist = cloudData[STORAGE_KEY_CONFIRMED_HISTORY] ? JSON.parse(cloudData[STORAGE_KEY_CONFIRMED_HISTORY]) : {};
    Object.keys(cloudHist).forEach((dateKey) => {
      if(!confirmedHistory[dateKey]) confirmedHistory[dateKey] = [];
      const existingKeys = new Set(confirmedHistory[dateKey].map((r) => JSON.stringify(r)));
      (cloudHist[dateKey] || []).forEach((r) => {
        const rk = JSON.stringify(r);
        if(!existingKeys.has(rk)){ confirmedHistory[dateKey].push(r); existingKeys.add(rk); }
      });
    });
  }catch(e){ console.warn('Không gộp được confirmedHistory từ Cloud:', e); }
}

async function saveConfirmedSnapshotAndReset(){
  const keys = Object.keys(confirmedKiemTonItems);
  if(!keys.length){
    alert('Danh sách đã xác nhận đang trống, không có gì để lưu.');
    return;
  }
  const dateKey = shiftDateDMY();
  const records = keys.map(k => {
    const item = confirmedKiemTonItems[k];
    const total = (parseFloat(item.inputs[0]) || 0) * (parseFloat(item.inputs[1]) || 1) +
                  (parseFloat(item.inputs[2]) || 0) * (parseFloat(item.inputs[3]) || 1) +
                  (parseFloat(item.inputs[4]) || 0) * (parseFloat(item.inputs[5]) || 1);
    // Chụp lại "Số pallet" NGAY TẠI THỜI ĐIỂM LƯU (dựa theo tồn kho hiện tại currentData, cùng cách
    // tính với cột "Số pallet" ở bảng Đã xác nhận) — phải chụp lại và LƯU KÈM vào bản ghi lịch sử
    // luôn, vì qua ngày khác tồn kho hiện tại đã đổi (upload file mới), không thể tính lại đúng SL
    // pallet của đúng thời điểm kiểm này nữa. Trước đây không lưu trường này nên "Lịch sử" luôn thiếu
    // cột Số pallet.
    const khoLabelFull = (item.data.kho || '').startsWith('Kho ') ? item.data.kho : 'Kho ' + (item.data.kho || '');
    const palletCount = computePalletCountFor(khoLabelFull, item.data.item, item.data.locator, item.data.custpo);
    return {
      kho: item.data.kho, item: item.data.item, custpo: item.data.custpo,
      locator: item.data.locator, oqc: item.data.oqc, qty: item.data.qty,
      actualResult: Math.round(total), palletCount,
      isWrongLocation: !!item.data.isWrongLocation, wmsLocator: item.data.wmsLocator || '',
      isWrongOqc: !!item.data.isWrongOqc, wmsOqc: item.data.wmsOqc || ''
    };
  });

  const btn = document.getElementById('btn-save-confirmed-history');
  if(btn) btn.disabled = true;
  const cloudActive = typeof CloudVault !== 'undefined' && CloudVault.url && CloudVault.token;

  // QUAN TRỌNG: huỷ các lượt tự lưu (autosave) còn đang chờ TRƯỚC khi lưu trữ + xoá trắng — giống hệt
  // lý do đã sửa ở nút "Đặt lại toàn bộ". Nếu vừa "Xác nhận" 1 dòng ngay trước khi bấm "Lưu", timer
  // tự lưu 2 giây (scheduleAutoSaveToCloud('confirm', ...)) của thao tác đó có thể vẫn còn đang chờ —
  // nếu không huỷ, nó sẽ tự chạy SAU khi "Lưu" đã xoá trắng + ghi lên Cloud, gửi writeMerge() bằng
  // đúng bộ khoá vừa xoá (KT đang nhập/lastCheck...) và có thể khiến Realtime tưởng lầm còn thay đổi
  // đang chờ hoặc kéo lại đúng lúc dữ liệu chưa ổn định — đây chính là nguyên nhân "bấm Lưu xong vài
  // giây sau bảng lại đầy như cũ" dù chỉ dùng 1 máy, không cần máy khác mở cùng lúc.
  ['cc','confirm','qrscan'].forEach(k => {
    if(typeof _autoSaveTimers !== 'undefined' && _autoSaveTimers[k]){
      clearTimeout(_autoSaveTimers[k]);
      _autoSaveTimers[k] = null;
    }
    if(typeof _pendingAutoSaveKeys !== 'undefined') _pendingAutoSaveKeys.delete(k);
  });
  if(typeof _ccAutoSaveTimer !== 'undefined' && _ccAutoSaveTimer){
    clearTimeout(_ccAutoSaveTimer);
    _ccAutoSaveTimer = null;
  }
  // Huỷ luôn hàng đợi tự-thử-lại (retry) của 1 lượt ghi TRƯỚC đó bị lỗi mạng tạm thời (nếu có) — cho
  // chắc chắn không còn lượt ghi "mồ côi" nào từ trước có thể tự chạy chồng lên ngay sau khi Lưu xong.
  if(typeof CloudVault !== 'undefined'){
    clearTimeout(CloudVault._retryTimer);
    CloudVault._retryCount = 0;
  }

  try{
    // Gộp trước phần "Đã xác nhận / KT đang nhập dở / GI đã quét / Lịch sử" MỚI NHẤT từ Cloud (đề
    // phòng người khác vừa xác nhận thêm dòng trên thiết bị khác) — TRƯỚC khi xoá trắng ở đây, để
    // không lỡ tay xoá mất phần họ vừa xác nhận mà máy này chưa kịp có.
    if(cloudActive){
      try{
        const cloudData = await CloudVault.peek();
        if(cloudData) mergeConfirmedDataFromCloud(cloudData);
      }catch(e){ console.warn('Không gộp được dữ liệu Cloud trước khi Lưu:', e); }
    }

    // Cùng ngày lưu nhiều lần trong ngày -> gộp thêm vào (không ghi đè mất phần đã lưu trước đó cùng ngày)
    confirmedHistory[dateKey] = (confirmedHistory[dateKey] || []).concat(records);

    // Chỉ giữ tối đa CONFIRMED_HISTORY_MAX_DAYS ngày gần nhất — xoá bớt ngày cũ hơn để tránh phình dung lượng
    const allDates = Object.keys(confirmedHistory).sort((a,b) => dmyToSortKey(b) - dmyToSortKey(a));
    allDates.slice(CONFIRMED_HISTORY_MAX_DAYS).forEach(d => delete confirmedHistory[d]);

    confirmedKiemTonItems = {};
    // Reset luôn toàn bộ "Đề xuất kiểm hôm nay" (cả 3 kho) — xoá sạch danh sách candidate cũ, mở khoá
    // lại các thẻ kho để chuẩn bị cho đợt "Tạo danh sách" kiểm kê lần sau, không để lẫn dữ liệu cũ.
    CC_KHO_LIST.forEach(k => ccClearKhoResult(k.label));
    // Xoá luôn toàn bộ số liệu KT nháp còn sót (nếu không, đợt kiểm kê sau lỡ trùng đúng item/locator/
    // PO/SL với đợt trước sẽ tự điền sẵn số cũ, gây nhầm lẫn) và danh sách GI đã quét (để đợt sau vẫn
    // quét lại đúng những pallet đó bình thường, không bị báo "đã quét trùng" nữa).
    ktInputValues = {};
    scannedGiSet.forEach(g => _deletedGiKeys.add(g));
    scannedGiSet.clear();
    giScanLog = [];
    if(typeof updateQrGiClearBtn === 'function') updateQrGiClearBtn();
    saveStateToStorage();
    renderConfirmedList();
    renderKhoSearchPage();
    renderConfirmedHistoryPopup();

    // QUAN TRỌNG: đẩy NGAY thay đổi này (đã lưu trữ + đã xoá trắng) lên Cloud bằng writeAll() — nếu
    // không, lần tải dữ liệu Cloud tiếp theo (mở lại trang, bấm "Làm mới dữ liệu", máy khác đăng
    // nhập...) sẽ lấy về bản CŨ vẫn còn nguyên trên Cloud (chưa từng được xoá) và làm danh sách vừa
    // xoá HIỆN LẠI y như cũ — đây chính là lỗi "bấm Lưu xong lại thấy xuất hiện lại, không xoá được".
    if(cloudActive){
      await CloudVault.writeAll();
      if(typeof clearUnsavedChanges === 'function') clearUnsavedChanges();
      showAppToast(`✓ Đã lưu trữ ${records.length} dòng vào lịch sử ngày ${dateKey}, làm mới bảng và đồng bộ lên Cloud.`);
    } else {
      showAppToast(`✓ Đã lưu trữ ${records.length} dòng vào lịch sử ngày ${dateKey}. Đã làm mới toàn bộ bảng cho đợt kiểm kê mới.`);
    }
  }catch(e){
    console.error('Lưu/đồng bộ Danh sách đã xác nhận lỗi:', e);
    showAppToast(`⚠ Đã lưu trữ ${records.length} dòng và làm mới bảng, nhưng CHƯA đồng bộ được lên Cloud (${e.message}). Bấm "Lưu" ở đầu trang để thử lại — nếu không, danh sách có thể hiện lại khi tải lại dữ liệu Cloud.`);
  }finally{
    if(btn) btn.disabled = false;
  }
}


// Vẽ nội dung popup Lịch sử — tab theo từng ngày (tối đa 5 ngày gần nhất), mặc định chọn ngày mới nhất
let confirmedHistoryActiveTab = null;
function renderConfirmedHistoryPopup(){
  const popup = document.getElementById('confirmed-history-popup');
  if(!popup) return;
  const dates = Object.keys(confirmedHistory).sort((a,b) => dmyToSortKey(b) - dmyToSortKey(a));
  if(!dates.length){
    popup.innerHTML = `<div class="confirmed-history-empty">Chưa lưu trữ lần nào. Bấm "Lưu" để lưu lại danh sách hiện tại.</div>`;
    return;
  }
  if(!confirmedHistoryActiveTab || !dates.includes(confirmedHistoryActiveTab)) confirmedHistoryActiveTab = dates[0];
  const tabsHtml = dates.map(d => `<span class="confirmed-history-tab${d === confirmedHistoryActiveTab ? ' active' : ''}" data-history-date="${escAttr(d)}">${escHtml(d)}</span>`).join('');
  const records = confirmedHistory[confirmedHistoryActiveTab] || [];
  const rowsHtml = records.map(r => `
    <tr>
      <td>${escHtml((r.kho || '').replace('Kho ',''))}</td>
      <td>${escHtml(r.item)}</td>
      <td>${escHtml(r.custpo || '')}</td>
      <td>${escHtml(r.locator)}</td>
      <td>${oqcBadge(r.oqc)}</td>
      <td class="num">${fmt(r.qty)}</td>
      <td class="num">${r.palletCount !== undefined && r.palletCount !== '' ? fmt(r.palletCount) : '—'}</td>
      <td class="num" style="color:var(--violet); font-weight:700;">${fmt(r.actualResult)}</td>
    </tr>`).join('');
  popup.innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:center; gap:8px; margin-bottom:10px; flex-wrap:wrap;">
      <div class="confirmed-history-tabs" style="margin-bottom:0;">${tabsHtml}</div>
      <button type="button" class="btn-update btn-ghost-outline" id="btn-export-confirmed-history" data-history-export-date="${escAttr(confirmedHistoryActiveTab)}" style="font-size:11.5px; padding:5px 10px; white-space:nowrap;">⬇ Xuất Excel</button>
    </div>
    <div style="font-size:11px; color:var(--muted-2); margin-bottom:8px;">${fmt(records.length)} dòng đã lưu ngày ${escHtml(confirmedHistoryActiveTab)} — chỉ giữ ${CONFIRMED_HISTORY_MAX_DAYS} ngày gần nhất. ${records.some(r => r.palletCount === undefined) ? '"—" ở cột Số pallet là các dòng lưu TRƯỚC bản cập nhật này, chưa có sẵn số liệu.' : ''}</div>
    <table class="kho-detail-table" style="width:100%;">
      <thead><tr><th>Kho</th><th>Item No.</th><th>Cust PO</th><th>Locator</th><th>OQC</th><th style="text-align:right">SL tồn</th><th style="text-align:right">Số pallet</th><th style="text-align:right">Kết quả KT</th></tr></thead>
      <tbody>${rowsHtml}</tbody>
    </table>`;
}

const btnSaveConfirmedHistory = document.getElementById('btn-save-confirmed-history');
if(btnSaveConfirmedHistory) btnSaveConfirmedHistory.addEventListener('click', saveConfirmedSnapshotAndReset);

document.addEventListener('click', (e) => {
  const toggle = e.target.closest('#btn-confirmed-history-toggle');
  const tab = e.target.closest('.confirmed-history-tab');
  const exportBtn = e.target.closest('#btn-export-confirmed-history');
  const popup = document.getElementById('confirmed-history-popup');
  if(toggle){
    if(popup){
      const willShow = popup.style.display === 'none';
      if(willShow) renderConfirmedHistoryPopup();
      popup.style.display = willShow ? 'block' : 'none';
    }
    return;
  }
  if(tab){
    confirmedHistoryActiveTab = tab.dataset.historyDate;
    renderConfirmedHistoryPopup();
    return;
  }
  if(exportBtn){
    exportConfirmedHistoryExcel(exportBtn.dataset.historyExportDate);
    return;
  }
  if(popup && popup.style.display !== 'none' && !e.target.closest('#confirmed-history-popup') && !e.target.closest('#btn-confirmed-history-toggle')){
    popup.style.display = 'none';
  }
});

// Dựng nút "Xuất Excel" theo TỪNG KHO đang có trong danh sách đã xác nhận (giống hệt cơ chế của
// "Đề xuất kiểm hôm nay") — có bao nhiêu kho thì hiện bấy nhiêu nút, mỗi nút chỉ xuất đúng kho đó.
function renderConfirmedExportButtons(){
  const wrap = document.getElementById('export-confirmed-btn-group');
  if(!wrap) return;
  const khoSet = new Set();
  Object.values(confirmedKiemTonItems).forEach(item => {
    const kho = item.data.kho || '';
    khoSet.add(kho.startsWith('Kho ') ? kho : 'Kho ' + kho);
  });
  const khoList = CC_KHO_LIST.map(k => k.label).filter(l => khoSet.has(l))
    .concat([...khoSet].filter(l => !CC_KHO_LIST.some(k => k.label === l)));
  if(!khoList.length){ wrap.innerHTML = ''; return; }
  wrap.innerHTML = khoList.map(khoLabel => `
    <button type="button" class="btn-export-excel" data-export-confirmed-kho="${escAttr(khoLabel)}" style="font-size:12px; padding:8px 14px;">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="m7 11 5 5 5-5"/><path d="M5 21h14"/></svg>
      Xuất Excel — ${escHtml(khoLabel.replace('Kho ',''))}
    </button>`).join('');
}
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-export-confirmed-kho]');
  if(!btn) return;
  exportConfirmedKhoExcel(btn.dataset.exportConfirmedKho);
});
const btnExportCombinedReport = document.getElementById('btn-export-combined-report');
if(btnExportCombinedReport) btnExportCombinedReport.addEventListener('click', exportCombinedReportAllKho);

// Đếm số pallet thực tế (1 GI No = 1 pallet) tại đúng kho + item + locator + custpo — dùng cho cột
// "Số pallet" ở sheet Đã xác nhận, giống hệt cách tính "SL pallet" bên Đề xuất kiểm.
function computePalletCountFor(khoLabel, item, locator, custpo){
  const rawRows = getRawRows(currentData).filter(r =>
    String(r[RAW_KEY_IDX.kho]) === khoLabel &&
    String(r[RAW_KEY_IDX.item] || '').toLowerCase() === String(item || '').toLowerCase() &&
    String(r[RAW_KEY_IDX.locator] || '') === locator &&
    String(r[RAW_KEY_IDX.custpo] || '').trim().toLowerCase() === String(custpo || '').trim().toLowerCase()
  );
  if(!rawRows.length) return '';
  const giSet = new Set();
  rawRows.forEach((r, idx) => giSet.add(r[RAW_KEY_IDX.gi] ? String(r[RAW_KEY_IDX.gi]) : ('__row' + idx)));
  return giSet.size;
}

// Xuất Excel cho "Danh sách đã xác nhận" — DÙNG CHUNG đúng 1 form/mẫu với bảng "Đề xuất kiểm hôm
// nay" (ccExportKhoExcel): cùng tiêu đề, cùng khung viền, cùng cột. Khác duy nhất 1 chỗ: cột cuối
// "Kết quả kiểm thực tế" được điền SẴN bằng đúng số liệu đã xác nhận, thay vì để trống điền tay.
// Dựng 1 sheet "Đã xác nhận" vào workbook đã có sẵn — trả về null nếu kho đó chưa có dòng nào xác
// nhận (để bên gọi biết mà bỏ qua/ẩn sheet), ngược lại trả về vài số liệu tóm tắt + toạ độ vùng dữ
// liệu biểu đồ (để chèn chart tròn THẬT vào file .xlsx ở bước hậu xử lý injectRealPieCharts()).
function ccBuildDaXacNhanSheet(workbook, khoLabel){
  const keys = Object.keys(confirmedKiemTonItems).filter(k => {
    const kho = confirmedKiemTonItems[k].data.kho || '';
    return (kho.startsWith('Kho ') ? kho : 'Kho ' + kho) === khoLabel;
  });
  if(!keys.length) return null;
  const rawRecords = keys.map(k => {
    const item = confirmedKiemTonItems[k];
    const total = (parseFloat(item.inputs[0]) || 0) * (parseFloat(item.inputs[1]) || 1) +
                  (parseFloat(item.inputs[2]) || 0) * (parseFloat(item.inputs[3]) || 1) +
                  (parseFloat(item.inputs[4]) || 0) * (parseFloat(item.inputs[5]) || 1);
    return { locator: item.data.locator, custpo: item.data.custpo, item: item.data.item, oqc: item.data.oqc, qty: item.data.qty, actualResult: Math.round(total) };
  });
  return ccBuildDaXacNhanSheetFromRecords(workbook, khoLabel, rawRecords, false);
}

// Dựng sheet "Đã xác nhận" từ 1 mảng bản ghi phẳng có sẵn {locator,custpo,item,qty,actualResult} —
// dùng chung cho cả xuất trực tiếp (từ confirmedKiemTonItems, palletCountMode=false -> tính SỐNG
// theo tồn kho HIỆN TẠI) lẫn xuất LỊCH SỬ theo ngày đã lưu (palletCountMode='stored' -> dùng đúng
// giá trị r.palletCount đã LƯU KÈM SẴN trong bản ghi lịch sử tại đúng thời điểm bấm "Lưu" — không
// tính lại theo tồn kho hiện tại, vì tồn kho hiện tại có thể đã khác xa thời điểm lưu; bản ghi lịch
// sử cũ chưa từng có trường này thì để trống thay vì hiện sai).
function ccBuildDaXacNhanSheetFromRecords(workbook, khoLabel, rawRecords, palletCountMode){
  if(!rawRecords || !rawRecords.length) return null;

  let flatRows = rawRecords.map(r => ({
    locator: r.locator,
    palletCount: palletCountMode === 'stored'
      ? (r.palletCount !== undefined && r.palletCount !== '' ? r.palletCount : '')
      : computePalletCountFor(khoLabel, r.item, r.locator, r.custpo),
    custpo: r.custpo,
    item: r.item,
    oqc: r.oqc || '',
    qty: r.qty,
    actualResult: r.actualResult
  }));

  flatRows = flatRows.slice().sort((a,b) => {
    const locCmp = String(a.locator).localeCompare(String(b.locator), 'vi');
    if(locCmp !== 0) return locCmp;
    const itemCmp = String(a.item).localeCompare(String(b.item), 'vi');
    if(itemCmp !== 0) return itemCmp;
    return String(a.custpo || '').localeCompare(String(b.custpo || ''), 'vi');
  });

  const khoCode = (CC_KHO_LIST.find(k => k.label === khoLabel) || {}).code || khoLabel.replace('Kho ', '');
  const ws = workbook.addWorksheet(`Da xac nhan ${khoCode}`.slice(0, 31));
  ws.pageSetup = {
    paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0,
    horizontalCentered: true, margins: { left:0.35, right:0.35, top:0.5, bottom:0.5, header:0.2, footer:0.2 }
  };

  const headers = ['STT', 'Locator', 'Số pallet', 'Cust PO', 'Item No.', 'OQC', 'Số lượng', 'Kết quả kiểm thực tế'];
  const thin = { style:'thin', color:{ argb:'FF999999' } };
  const thick = { style:'medium', color:{ argb:'FF222222' } };

  ws.mergeCells(1,1,1,headers.length);
  const titleCell = ws.getCell(1,1);
  titleCell.value = `Danh sách đã xác nhận kiểm — ${khoLabel}`;
  titleCell.font = { bold:true, size:13 };

  ws.mergeCells(2,1,2,headers.length);
  const dateCell = ws.getCell(2,1);
  dateCell.value = `Ngày in: ${new Date().toLocaleDateString('vi-VN')} · Tổng số dòng: ${flatRows.length}`;
  dateCell.font = { italic:true, color:{ argb:'FF666666' } };

  const headerExcelRow = 4;
  ws.pageSetup.printTitlesRow = `${headerExcelRow}:${headerExcelRow}`;
  ws.getRow(headerExcelRow).values = headers;
  const headerRow = ws.getRow(headerExcelRow);
  headerRow.font = { bold:true };
  headerRow.height = 20;
  headerRow.eachCell(cell => {
    cell.fill = { type:'pattern', pattern:'solid', fgColor:{ argb:'FFEFEFEF' } };
    cell.alignment = { vertical:'middle', horizontal:'center', wrapText:true };
    cell.border = { top:thick, left:thin, right:thin, bottom:thick };
  });

  ws.columns = [
    { width:5 }, { width:14 }, { width:9 }, { width:14 }, { width:14 }, { width:9 }, { width:9 }, { width:22 }
  ];

  let mismatchCount = 0, okCount = 0, shortCount = 0, surplusCount = 0;
  flatRows.forEach((r, i) => {
    const excelRowNum = headerExcelRow + 1 + i;
    const isLastOfGroup = (i === flatRows.length - 1) || (flatRows[i+1].locator !== r.locator);
    const isFirstOfGroup = (i === 0) || (flatRows[i-1].locator !== r.locator);
    const row = ws.getRow(excelRowNum);
    row.values = [
      i + 1,
      r.locator,
      r.palletCount || '',
      r.custpo || '',
      r.item,
      r.oqc || '',
      typeof r.qty === 'number' ? r.qty : (parseFloat(r.qty) || 0),
      r.actualResult
    ];
    row.alignment = { vertical:'middle' };
    for(let c = 1; c <= headers.length; c++){
      const cell = row.getCell(c);
      cell.border = {
        top: isFirstOfGroup ? thick : thin,
        bottom: isLastOfGroup ? thick : thin,
        left: (c === 1) ? thick : thin,
        right: (c === headers.length) ? thick : thin
      };
      if(c === 2 || c === 3 || c === 4 || c === 5) cell.alignment = { vertical:'middle', horizontal:'left', wrapText:true };
      else if(c === 7 || c === 8) cell.alignment = { vertical:'middle', horizontal:'right' };
      else cell.alignment = { vertical:'middle', horizontal:'center' };
    }
    const qtyNum = typeof r.qty === 'number' ? r.qty : (parseFloat(r.qty) || 0);
    const mismatch = Math.round(qtyNum) !== Math.round(r.actualResult);
    if(mismatch) mismatchCount++;
    if(Math.round(r.actualResult) === Math.round(qtyNum)) okCount++;
    else if(Math.round(r.actualResult) < Math.round(qtyNum)) shortCount++;
    else surplusCount++;
    row.getCell(8).font = mismatch
      ? { bold:true, color:{ argb:'FFD6394B' } }
      : { bold:false, color:{ argb:'FF000000' } };
  });

  // Biểu đồ tròn Match (khớp, xanh lá) / Negative (thiếu, đỏ) / Positive (dư, vàng cam). Ghi vào
  // các ô thật (cột J:K) để bước hậu xử lý injectRealPieCharts() gắn 1 chart Excel THẬT tham chiếu
  // đúng vào các ô này (không phải ảnh tĩnh — bấm vào chart trong Excel vẫn xem/sửa số liệu được).
  // 3 số Match/Negative/Positive + Grand Total dùng CÔNG THỨC EXCEL THẬT (SUMPRODUCT/SUM) so trực
  // tiếp cột G "Số lượng" với cột H "Kết quả kiểm thực tế" của CHÍNH bảng dữ liệu — không ghi cứng
  // số JS tính sẵn vào ô nữa: sửa/thêm dòng trong bảng ở Excel thì các số này (và cả chart) tự cập
  // nhật theo khi mở lại/tính toán lại, không cần PivotTable thật (đã thử ở bản trước, bị Excel báo
  // lỗi nội dung do OOXML PivotTable quá phức tạp để tự ghép tay an toàn — dùng công thức thường an
  // toàn tuyệt đối vì không đụng gì tới cấu trúc nội bộ ngoài chuẩn của Excel).
  const matchCount = okCount;
  const negativeCount = shortCount;   // thiếu so với SL tồn
  const positiveCount = surplusCount; // dư so với SL tồn
  const chartDataRow = headerExcelRow; // hàng 4 — cùng hàng với tiêu đề cột của bảng chính
  const dataFirstRow = headerExcelRow + 1;
  const dataLastRow = headerExcelRow + flatRows.length;
  const cRange = `$C$${dataFirstRow}:$C$${dataLastRow}`; // cột "Số pallet"
  const eRange = `$E$${dataFirstRow}:$E$${dataLastRow}`; // cột "Item No."
  const oqcRange = `$F$${dataFirstRow}:$F$${dataLastRow}`; // cột "OQC"
  const fRange = `$G$${dataFirstRow}:$G$${dataLastRow}`; // cột "Số lượng"
  const gRange = `$H$${dataFirstRow}:$H$${dataLastRow}`; // cột "Kết quả kiểm thực tế"
  ws.getCell(chartDataRow, 10).value = 'Row Labels';
  ws.getCell(chartDataRow, 11).value = 'Count of Result';
  ws.getRow(chartDataRow).getCell(10).font = { bold:true };
  ws.getRow(chartDataRow).getCell(11).font = { bold:true };
  const chartRowLabels = ['Match', 'Negative', 'Positive'];
  const chartRowFormulas = [
    `SUMPRODUCT((${fRange}=${gRange})*1)`,   // Match: Số lượng = Kết quả kiểm thực tế
    `SUMPRODUCT((${gRange}<${fRange})*1)`,   // Negative: kiểm được ÍT hơn SL tồn (thiếu)
    `SUMPRODUCT((${gRange}>${fRange})*1)`    // Positive: kiểm được NHIỀU hơn SL tồn (dư)
  ];
  const chartRowResults = [matchCount, negativeCount, positiveCount];
  chartRowLabels.forEach((label, i) => {
    ws.getCell(chartDataRow + 1 + i, 10).value = label;
    ws.getCell(chartDataRow + 1 + i, 11).value = { formula: chartRowFormulas[i], result: chartRowResults[i] };
  });
  ws.getCell(chartDataRow + 4, 10).value = 'Grand Total';
  ws.getCell(chartDataRow + 4, 11).value = {
    formula: `SUM($K$${chartDataRow + 1}:$K$${chartDataRow + 3})`,
    result: matchCount + negativeCount + positiveCount
  };
  ws.getRow(chartDataRow + 4).getCell(10).font = { bold:true };
  ws.getRow(chartDataRow + 4).getCell(11).font = { bold:true };
  ws.getColumn(10).width = 18;
  ws.getColumn(11).width = 12;

  // Bảng tổng hợp theo Item No. + OQC (cột N:R) — y hệt kiểu PivotTable người dùng đang tự dựng tay
  // trong Excel sau khi xuất file (Row Labels = Item No., thêm cột OQC, rồi Sum of Số pallet/Số
  // lượng/Kết quả kiểm thực tế) — nay dựng SẴN, dùng công thức SUMIFS thật (2 điều kiện: Item No. +
  // OQC) tham chiếu đúng vào bảng dữ liệu chính (cột C/E/F/G/H) để tự cập nhật nếu sửa/thêm dòng,
  // không phải PivotTable thật (lý do xem chú thích ở khối J:K phía trên) nhưng vẫn "sống" giống hệt.
  // Gộp theo CẶP Item+OQC (không chỉ theo Item) vì cùng 1 mã hàng có thể có nhiều dòng PASS/NG khác
  // nhau — gộp chung sẽ làm mất thông tin OQC ở bảng tổng hợp.
  const distinctItemOqcPairs = [];
  const seenPairKeys = new Set();
  flatRows.forEach(r => {
    const key = r.item + '␟' + (r.oqc || '');
    if(!seenPairKeys.has(key)){ seenPairKeys.add(key); distinctItemOqcPairs.push({ item: r.item, oqc: r.oqc || '' }); }
  });
  distinctItemOqcPairs.sort((a,b) => {
    const itemCmp = String(a.item).localeCompare(String(b.item), 'vi');
    if(itemCmp !== 0) return itemCmp;
    return String(a.oqc).localeCompare(String(b.oqc), 'vi');
  });
  ws.getCell(chartDataRow, 14).value = 'Row Labels';
  ws.getCell(chartDataRow, 15).value = 'OQC';
  ws.getCell(chartDataRow, 16).value = 'Sum of Số pallet';
  ws.getCell(chartDataRow, 17).value = 'Sum of Số lượng';
  ws.getCell(chartDataRow, 18).value = 'Sum of Kết quả kiểm thực tế';
  [14,15,16,17,18].forEach(c => { ws.getRow(chartDataRow).getCell(c).font = { bold:true }; });
  distinctItemOqcPairs.forEach((pair, i) => {
    const r = chartDataRow + 1 + i;
    const pairRows = flatRows.filter(x => x.item === pair.item && (x.oqc || '') === pair.oqc);
    const palletSumForPair = pairRows.reduce((s,x) => s + (typeof x.palletCount === 'number' ? x.palletCount : 0), 0);
    const qtySumForPair = pairRows.reduce((s,x) => s + (typeof x.qty === 'number' ? x.qty : (parseFloat(x.qty) || 0)), 0);
    const resultSumForPair = pairRows.reduce((s,x) => s + (Math.round(x.actualResult) || 0), 0);
    ws.getCell(r, 14).value = pair.item;
    ws.getCell(r, 15).value = pair.oqc;
    ws.getCell(r, 16).value = { formula: `SUMIFS(${cRange},${eRange},$N$${r},${oqcRange},$O$${r})`, result: palletSumForPair };
    ws.getCell(r, 17).value = { formula: `SUMIFS(${fRange},${eRange},$N$${r},${oqcRange},$O$${r})`, result: qtySumForPair };
    ws.getCell(r, 18).value = { formula: `SUMIFS(${gRange},${eRange},$N$${r},${oqcRange},$O$${r})`, result: resultSumForPair };
  });
  const itemGrandRow = chartDataRow + 1 + distinctItemOqcPairs.length;
  const itemFirstRow = chartDataRow + 1;
  const itemLastRow = chartDataRow + distinctItemOqcPairs.length;
  const pairSum = (fn) => distinctItemOqcPairs.reduce((s,pair) => s + flatRows.filter(x=>x.item===pair.item && (x.oqc||'')===pair.oqc).reduce((ss,x)=>ss+fn(x),0), 0);
  ws.getCell(itemGrandRow, 14).value = 'Grand Total';
  ws.getCell(itemGrandRow, 16).value = { formula: `SUM($P$${itemFirstRow}:$P$${itemLastRow})`, result: pairSum(x => typeof x.palletCount === 'number' ? x.palletCount : 0) };
  ws.getCell(itemGrandRow, 17).value = { formula: `SUM($Q$${itemFirstRow}:$Q$${itemLastRow})`, result: pairSum(x => typeof x.qty === 'number' ? x.qty : (parseFloat(x.qty)||0)) };
  ws.getCell(itemGrandRow, 18).value = { formula: `SUM($R$${itemFirstRow}:$R$${itemLastRow})`, result: pairSum(x => Math.round(x.actualResult)||0) };
  [14,15,16,17,18].forEach(c => { ws.getRow(itemGrandRow).getCell(c).font = { bold:true }; });
  ws.getColumn(14).width = 16;
  ws.getColumn(15).width = 10;
  ws.getColumn(16).width = 16;
  ws.getColumn(17).width = 16;
  ws.getColumn(18).width = 24;

  // Tổng SL pallet + tổng số vị trí (locator) KHÁC NHAU — hiện thêm vào tiêu đề chart tròn, bên
  // cạnh số dòng, để nhìn tiêu đề là biết ngay quy mô đợt kiểm (không phải mở bảng đếm tay).
  // palletCountMode='stored' (xuất Lịch sử của bản ghi cũ chưa có Số pallet) có thể không có đủ số
  // liệu Số pallet đáng tin -> bỏ qua phần này khỏi tiêu đề, tránh hiện sai.
  const hasReliablePalletSum = palletCountMode !== 'stored' || flatRows.every(r => typeof r.palletCount === 'number');
  const locatorCount = new Set(flatRows.map(r => r.locator)).size;
  const palletSum = flatRows.reduce((s, r) => s + (typeof r.palletCount === 'number' ? r.palletCount : 0), 0);
  const titleExtra = hasReliablePalletSum
    ? ` · ${fmt(locatorCount)} vị trí · ${fmt(palletSum)} pallet`
    : ` · ${fmt(locatorCount)} vị trí`;

  return {
    rowCount: flatRows.length, mismatchCount, okCount, shortCount, surplusCount, matchCount, negativeCount, positiveCount,
    locatorCount, palletSum,
    chartInfo: {
      sheetName: ws.name,
      catRange: `$J$${chartDataRow + 1}:$J$${chartDataRow + 3}`,
      valRange: `$K$${chartDataRow + 1}:$K$${chartDataRow + 3}`,
      categories: ['Match', 'Negative', 'Positive'],
      values: [matchCount, negativeCount, positiveCount],
      colors: ['00B050', 'FF0000', 'FFC000'],
      title: `Kiểm kho ${khoLabel.replace('Kho ', '')} — ${flatRows.length} dòng${titleExtra}`
    }
  };
}

function escapeXmlChart(s){
  return String(s == null ? '' : s).replace(/[<>&'"]/g, c => ({ '<':'&lt;', '>':'&gt;', '&':'&amp;', "'":'&apos;', '"':'&quot;' }[c]));
}

// Hậu xử lý file .xlsx (đã xuất qua ExcelJS) để chèn CHART TRÒN THẬT của Excel (không phải ảnh) —
// vì ExcelJS không hỗ trợ tạo chart. Cách làm: file .xlsx thực chất là 1 file ZIP chứa các XML theo
// chuẩn OOXML; ở đây tự tay ghép thêm phần chart{N}.xml + drawing{N}.xml + các file quan hệ
// (.rels) cần thiết, tham chiếu đúng vào các ô dữ liệu thật đã ghi sẵn trong sheet (cột J:K) — nên
// khi mở trong Excel, chart này bấm vào sửa/xem số liệu gốc được như chart tạo tay bình thường.
// chartSpecs: [{ sheetPosition (số thứ tự sheet trong workbook, 1 = sheet đầu tiên), chartInfo }]
// Nếu thiếu JSZip hoặc có lỗi khi ghép XML, trả về nguyên buffer gốc (file vẫn mở được, chỉ là
// không có chart) để không làm hỏng cả file xuất ra.
async function injectRealPieCharts(buffer, chartSpecs){
  if(!LIB_JSZIP_OK || !chartSpecs || !chartSpecs.length) return buffer;
  try{
    const zip = await JSZip.loadAsync(buffer);
    let contentTypesXml = await zip.file('[Content_Types].xml').async('string');
    let chartIndex = 0;

    for(const spec of chartSpecs){
      chartIndex++;
      const drawingIndex = chartIndex;
      const info = spec.chartInfo;
      const sheetFile = `xl/worksheets/sheet${spec.sheetPosition}.xml`;
      const sheetRelsPath = `xl/worksheets/_rels/sheet${spec.sheetPosition}.xml.rels`;
      const chartPath = `xl/charts/chart${chartIndex}.xml`;
      const drawingPath = `xl/drawings/drawing${drawingIndex}.xml`;
      const drawingRelsPath = `xl/drawings/_rels/drawing${drawingIndex}.xml.rels`;

      const sheetNameEsc = /^[A-Za-z_][A-Za-z0-9_]*$/.test(info.sheetName) ? info.sheetName : `'${info.sheetName}'`;
      const catPts = info.categories.map((c,i) => `<c:pt idx="${i}"><c:v>${escapeXmlChart(c)}</c:v></c:pt>`).join('');
      const valPts = info.values.map((v,i) => `<c:pt idx="${i}"><c:v>${v}</c:v></c:pt>`).join('');
      const dPts = info.colors.map((col,i) => `<c:dPt><c:idx val="${i}"/><c:bubble3D val="0"/><c:spPr><a:solidFill><a:srgbClr val="${col}"/></a:solidFill></c:spPr></c:dPt>`).join('');

      const chartXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<c:chart>
<c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="1400" b="1"/></a:pPr><a:r><a:rPr lang="vi-VN" sz="1400" b="1"/><a:t>${escapeXmlChart(info.title)}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title>
<c:autoTitleDeleted val="0"/>
<c:plotArea><c:layout/>
<c:pieChart>
<c:varyColors val="1"/>
<c:ser>
<c:idx val="0"/><c:order val="0"/>
${dPts}
<c:dLbls>
<c:numFmt formatCode="0%" sourceLinked="0"/>
<c:spPr><a:solidFill><a:srgbClr val="404040"><a:alpha val="85000"/></a:srgbClr></a:solidFill></c:spPr>
<c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="1400" b="1"><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a:defRPr></a:pPr><a:endParaRPr lang="vi-VN"/></a:p></c:txPr>
<c:dLblPos val="bestFit"/>
<c:showLegendKey val="0"/><c:showVal val="0"/><c:showCatName val="0"/><c:showSerName val="0"/><c:showPercent val="1"/><c:showBubbleSize val="0"/>
</c:dLbls>
<c:cat><c:strRef><c:f>${sheetNameEsc}!${info.catRange}</c:f><c:strCache><c:ptCount val="${info.categories.length}"/>${catPts}</c:strCache></c:strRef></c:cat>
<c:val><c:numRef><c:f>${sheetNameEsc}!${info.valRange}</c:f><c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="${info.values.length}"/>${valPts}</c:numCache></c:numRef></c:val>
</c:ser>
<c:firstSliceAng val="0"/>
</c:pieChart>
<c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr>
</c:plotArea>
<c:legend><c:legendPos val="r"/><c:overlay val="0"/></c:legend>
<c:plotVisOnly val="1"/>
</c:chart>
</c:chartSpace>`;
      zip.file(chartPath, chartXml);

      // Chart tự co GIÃN CHIỀU RỘNG theo đúng độ dài chữ tiêu đề — tránh tiêu đề dài (kho nhiều dòng/
      // vị trí/pallet) bị tự xuống 2 hàng làm chart cao lên xấu. Trước đây KHÔNG ghim cỡ chữ tiêu đề
      // (để Excel tự chọn cỡ chữ theo kích thước chart) nên không tính trước được chính xác cần bao
      // nhiêu px — Excel thường tự chọn cỡ chữ LỚN hơn hẳn 8.5px/ký tự đã ước lượng, khiến tiêu đề vẫn
      // bị xuống 2 hàng dù đã có công thức tự co giãn. Giờ GHIM CỨNG cỡ chữ tiêu đề = 14pt đậm (xem
      // <c:title> phía trên) rồi tính px theo ĐÚNG cỡ chữ đã ghim đó (~10px/ký tự ở 14pt đậm, chữ có
      // dấu tiếng Việt) — đảm bảo tiêu đề luôn nằm gọn 1 hàng. Biên 400–900px để không quá nhỏ/quá khổ.
      const chartWidthPx = Math.min(900, Math.max(400, 60 + info.title.length * 10));
      const chartHeightPx = 330;
      const chartExtCx = Math.round(chartWidthPx * 9525); // 1px = 9525 EMU
      const chartExtCy = Math.round(chartHeightPx * 9525);

      const drawingXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
<xdr:oneCellAnchor>
<xdr:from><xdr:col>9</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>9</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>
<xdr:ext cx="${chartExtCx}" cy="${chartExtCy}"/>
<xdr:graphicFrame macro="">
<xdr:nvGraphicFramePr><xdr:cNvPr id="${drawingIndex+1}" name="Chart ${drawingIndex}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr>
<xdr:xfrm><a:off x="0" y="0"/><a:ext cx="${chartExtCx}" cy="${chartExtCy}"/></xdr:xfrm>
<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="rId1"/></a:graphicData></a:graphic>
</xdr:graphicFrame>
<xdr:clientData/>
</xdr:oneCellAnchor>
</xdr:wsDr>`;
      zip.file(drawingPath, drawingXml);

      const drawingRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart${chartIndex}.xml"/>
</Relationships>`;
      zip.file(drawingRelsPath, drawingRelsXml);

      let sheetRelsXml;
      const existingRelsFile = zip.file(sheetRelsPath);
      let nextRid = 1;
      if(existingRelsFile){
        sheetRelsXml = await existingRelsFile.async('string');
        const ids = [...sheetRelsXml.matchAll(/Id="rId(\d+)"/g)].map(m => parseInt(m[1], 10));
        nextRid = ids.length ? Math.max(...ids) + 1 : 1;
        sheetRelsXml = sheetRelsXml.replace('</Relationships>',
          `<Relationship Id="rId${nextRid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing${drawingIndex}.xml"/></Relationships>`);
      } else {
        sheetRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId${nextRid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing${drawingIndex}.xml"/>
</Relationships>`;
      }
      zip.file(sheetRelsPath, sheetRelsXml);

      let sheetXml = await zip.file(sheetFile).async('string');
      const drawingTag = `<drawing r:id="rId${nextRid}"/>`;
      sheetXml = sheetXml.includes('<extLst>')
        ? sheetXml.replace('<extLst>', drawingTag + '<extLst>')
        : sheetXml.replace('</worksheet>', drawingTag + '</worksheet>');
      zip.file(sheetFile, sheetXml);

      const overrideEntries =
        `<Override PartName="/${drawingPath}" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>` +
        `<Override PartName="/${chartPath}" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>`;
      contentTypesXml = contentTypesXml.replace('</Types>', overrideEntries + '</Types>');
    }

    zip.file('[Content_Types].xml', contentTypesXml);
    return await zip.generateAsync({ type:'blob', mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }catch(err){
    console.warn('Không chèn được biểu đồ tròn thật vào Excel — xuất file không kèm chart:', err);
    return buffer;
  }
}

async function exportConfirmedKhoExcel(khoLabel){
  if(!LIB_EXCELJS_OK){ alert('Không xuất được Excel: thư viện ExcelJS chưa tải được (cần Internet).'); return; }
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'TN5 Dashboard';
  workbook.created = new Date();
  const summary = ccBuildDaXacNhanSheet(workbook, khoLabel);
  if(!summary){ alert(`Chưa có dòng nào đã xác nhận cho ${khoLabel}.`); return; }
  const buffer = await workbook.xlsx.writeBuffer();
  const chartSpecs = summary.chartInfo ? [{ sheetPosition: 1, chartInfo: summary.chartInfo }] : [];
  const processed = await injectRealPieCharts(buffer, chartSpecs);
  const blob = processed instanceof Blob ? processed : new Blob([processed], { type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const khoCodeSafe = khoLabel.replace(/[^0-9A-Za-z]/g, '_');
  const stamp = new Date().toISOString().slice(0,10);
  a.href = url;
  a.download = `Da_xac_nhan_Kiem_ton_${khoCodeSafe}_${stamp}.xlsx`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// Xuất báo cáo Excel cho 1 NGÀY đã lưu trong Lịch sử — giống hệt cấu trúc "Xuất báo cáo tổng hợp (3
// kho)": sheet "Tổng quan" + 1 sheet "Đã xác nhận {kho}" (kèm chart tròn thật) cho mỗi kho có dữ
// liệu trong ngày đó. Không tính lại "Số pallet" vì tồn kho hiện tại có thể đã khác thời điểm lưu.
async function exportConfirmedHistoryExcel(dateKey){
  if(!LIB_EXCELJS_OK){ alert('Không xuất được Excel: thư viện ExcelJS chưa tải được (cần Internet).'); return; }
  const records = confirmedHistory[dateKey];
  if(!records || !records.length){ alert(`Không có dữ liệu đã lưu cho ngày ${dateKey}.`); return; }

  const byKho = {};
  records.forEach(r => {
    const kho = r.kho && r.kho.startsWith('Kho ') ? r.kho : 'Kho ' + (r.kho || '');
    if(!byKho[kho]) byKho[kho] = [];
    byKho[kho].push(r);
  });
  const khoList = CC_KHO_LIST.filter(k => byKho[k.label]);

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'TN5 Dashboard';
  workbook.created = new Date();
  const wsOverview = workbook.addWorksheet('Tong quan');

  const summaryRows = [];
  const chartSpecs = [];
  let nextSheetPosition = 2; // sheet 1 = Tổng quan
  khoList.forEach(k => {
    const khoRecords = byKho[k.label].map(r => ({ locator: r.locator, custpo: r.custpo, item: r.item, oqc: r.oqc, qty: r.qty, actualResult: r.actualResult, palletCount: r.palletCount }));
    const stats = ccBuildDaXacNhanSheetFromRecords(workbook, k.label, khoRecords, 'stored');
    if(stats){
      chartSpecs.push({ sheetPosition: nextSheetPosition, chartInfo: stats.chartInfo });
      nextSheetPosition++;
      summaryRows.push({ kho: k.label.replace('Kho ', ''), rowCount: stats.rowCount, mismatchCount: stats.mismatchCount, matchCount: stats.matchCount, negativeCount: stats.negativeCount, positiveCount: stats.positiveCount });
    }
  });

  const headers = ['Kho', 'Số dòng đã kiểm', 'Match', 'Negative', 'Positive', 'Tỷ lệ sai lệch'];
  const thin = { style:'thin', color:{ argb:'FF999999' } };
  const thick = { style:'medium', color:{ argb:'FF222222' } };
  wsOverview.pageSetup = {
    paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0,
    horizontalCentered: true, margins: { left:0.35, right:0.35, top:0.5, bottom:0.5, header:0.2, footer:0.2 }
  };
  wsOverview.mergeCells(1,1,1,headers.length);
  wsOverview.getCell(1,1).value = `Báo cáo Kiểm tồn kho — Lịch sử ngày ${dateKey}`;
  wsOverview.getCell(1,1).font = { bold:true, size:14 };
  wsOverview.mergeCells(2,1,2,headers.length);
  wsOverview.getCell(2,1).value = `Ngày in: ${new Date().toLocaleDateString('vi-VN')}`;
  wsOverview.getCell(2,1).font = { italic:true, color:{ argb:'FF666666' } };
  const headerRowNum = 4;
  wsOverview.getRow(headerRowNum).values = headers;
  const hRow = wsOverview.getRow(headerRowNum);
  hRow.font = { bold:true };
  hRow.height = 20;
  hRow.eachCell(cell => {
    cell.fill = { type:'pattern', pattern:'solid', fgColor:{ argb:'FFEFEFEF' } };
    cell.alignment = { vertical:'middle', horizontal:'center', wrapText:true };
    cell.border = { top:thick, left:thin, right:thin, bottom:thick };
  });
  wsOverview.columns = [{ width:10 }, { width:16 }, { width:10 }, { width:10 }, { width:10 }, { width:14 }];

  let totalRow2=0, totalMatch=0, totalNeg=0, totalPos=0, totalMismatch=0;
  summaryRows.forEach((s, i) => {
    const rn = headerRowNum + 1 + i;
    const row = wsOverview.getRow(rn);
    const ratio = s.rowCount ? (s.mismatchCount / s.rowCount * 100).toFixed(1) + '%' : '0%';
    row.values = [s.kho, s.rowCount, s.matchCount, s.negativeCount, s.positiveCount, ratio];
    row.alignment = { vertical:'middle' };
    for(let c = 1; c <= headers.length; c++){
      const cell = row.getCell(c);
      cell.border = { top:thin, bottom:thin, left: c===1?thick:thin, right: c===headers.length?thick:thin };
      cell.alignment = { vertical:'middle', horizontal: c===1 ? 'center' : 'right' };
    }
    totalRow2 += s.rowCount; totalMatch += s.matchCount; totalNeg += s.negativeCount; totalPos += s.positiveCount; totalMismatch += s.mismatchCount;
  });
  const totalRn = headerRowNum + 1 + summaryRows.length;
  const totalRow = wsOverview.getRow(totalRn);
  const totalRatio = totalRow2 ? (totalMismatch / totalRow2 * 100).toFixed(1) + '%' : '0%';
  totalRow.values = ['Tổng', totalRow2, totalMatch, totalNeg, totalPos, totalRatio];
  totalRow.font = { bold:true };
  for(let c = 1; c <= headers.length; c++){
    const cell = totalRow.getCell(c);
    cell.fill = { type:'pattern', pattern:'solid', fgColor:{ argb:'FFF6F6F6' } };
    cell.border = { top:thick, bottom:thick, left: c===1?thick:thin, right: c===headers.length?thick:thin };
    cell.alignment = { vertical:'middle', horizontal: c===1 ? 'center' : 'right' };
  }

  const buffer = await workbook.xlsx.writeBuffer();
  const processed = await injectRealPieCharts(buffer, chartSpecs);
  const blob = processed instanceof Blob ? processed : new Blob([processed], { type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const dateSafe = dateKey.replace(/\//g, '-');
  a.href = url;
  a.download = `Bao_cao_ngay_${dateSafe}.xlsx`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/* ============================================================================
   ĐỀ XUẤT KIỂM HÔM NAY (Smart Cycle Count Scheduling) — chia theo 3 kho: 2B / 3A / 3B
   3 chế độ chọn số lượng cần kiểm, mỗi kho có thanh trượt % riêng:
   - "Mã hàng"  : % trên tổng số dòng Item No.+Locator riêng biệt của kho
   - "Locator"  : % trên tổng số vị trí (locator) riêng biệt của kho
   - "Pallet"   : % trên tổng số pallet (mỗi dòng GI No. trong tồn kho = 1 pallet) của kho
   Tự động loại bỏ các locator chứa "pick" hoặc "loading" (khu trung chuyển tạm,
   không phải vị trí lưu kho cố định cần cycle-count).
   Điểm ưu tiên dựa trên: lâu chưa kiểm (40%) · vận động nhanh Transaction (35%) · từng lệch WMS-ERP (25%).
   Chỉ dùng dữ liệu đã có sẵn trong dashboard, không cần nguồn mới.
============================================================================ */
const CC_KHO_LIST = [
  { label:'Kho 2B', code:'2B' },
  { label:'Kho 3A', code:'3A' },
  { label:'Kho 3B', code:'3B' }
];
const CC_MOVE_WINDOW_DAYS = 30;
let ccKhoMode = { 'Kho 2B':'locator', 'Kho 3A':'locator', 'Kho 3B':'locator' };
let ccKhoResults = {}; // { 'Kho 2B': { mode, list } }

function ccIsExcludedLocator(locator, allowPick){
  // Loại các vị trí Loading / PROD — khu trung chuyển hoặc khu sản xuất, không phải vị trí lưu kho cố
  // định. Vị trí PICK mặc định cũng bị loại (không tính vào Đề xuất kiểm hôm nay tự động), TRỪ KHI
  // allowPick=true — dùng cho danh sách "Tự chọn" để người dùng vẫn chọn tay được các vị trí PICK khi
  // cần đối chiếu (VD: hàng đang tạm để ở khu Pick trước khi xuất).
  const s = String(locator || '');
  return allowPick ? /loading|prod/i.test(s) : /pick|loading|prod/i.test(s);
}

// Nhóm "SPP": các Item No. KHÔNG bắt đầu bằng số 0 — loại hẳn ra khỏi Đề xuất kiểm hôm nay
// (đây là nhóm hàng khác quy ước, không thuộc phạm vi cycle-count theo Item No. thường).
function ccIsSppItem(item){
  return !/^0/.test(String(item || '').trim());
}

// Gộp theo kho+item+locator+Cust PO (mỗi Cust PO khác nhau tách thành 1 dòng riêng), cộng dồn SL tồn,
// đếm số pallet THEO ĐÚNG SỐ DÒNG GI NO. GỐC (dùng raw_rows chi tiết từng dòng, không dùng kho_detail
// vì kho_detail đã gộp sẵn theo item+custpo+locator+oqc+ref nên mất granularity GI No.).
// Đã loại locator PICK/Loading/PROD và loại nhóm SPP (Item No. không bắt đầu bằng số 0).
function ccBuildInventoryRows(allowPick){
  const rows = new Map(); // key(kho||item||locator||custpo) -> { item, locator, kho, custpo, oqc, qty, palletCount }
  if(!currentData) return rows;
  const raw = getRawRows(currentData);
  raw.forEach(r => {
    const kho = r[RAW_KEY_IDX.kho], item = r[RAW_KEY_IDX.item], custpo = r[RAW_KEY_IDX.custpo] || '',
          locator = r[RAW_KEY_IDX.locator], oqc = r[RAW_KEY_IDX.oqc] || '', qty = Number(r[RAW_KEY_IDX.qty]) || 0;
    if(!item || !locator || !kho) return;
    if(ccIsExcludedLocator(locator, allowPick)) return;
    if(ccIsSppItem(item)) return;
    const key = kho + '||' + item + '||' + locator + '||' + custpo;
    if(rows.has(key)){
      const row = rows.get(key);
      row.qty += qty;
      row.palletCount += 1;
    } else {
      rows.set(key, { item, locator, kho, custpo, oqc, qty, palletCount: 1 });
    }
  });
  return rows;
}

// Đếm số mã SPP (Item No. không bắt đầu bằng 0) đã bị loại khỏi mỗi kho — chỉ để hiển thị cho biết
function ccGetSppCounts(){
  const counts = {};
  CC_KHO_LIST.forEach(k => counts[k.label] = new Set());
  if(!currentData) return CC_KHO_LIST.reduce((o,k)=>(o[k.label]=0,o), {});
  const raw = getRawRows(currentData);
  raw.forEach(r => {
    const kho = r[RAW_KEY_IDX.kho], item = r[RAW_KEY_IDX.item], locator = r[RAW_KEY_IDX.locator];
    if(!item || !locator || !kho || !counts[kho]) return;
    if(ccIsExcludedLocator(locator)) return;
    if(ccIsSppItem(item)) counts[kho].add(item);
  });
  const out = {};
  CC_KHO_LIST.forEach(k => out[k.label] = counts[k.label].size);
  return out;
}

/* ---------- Snapshot lịch sử tồn kho theo ngày (để tính "SL tồn bất thường") ---------- */

function ccTodayStr(){
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
}

// Gọi mỗi khi dữ liệu tồn kho được cập nhật (tải file mới / đồng bộ Cloud / dữ liệu mặc định lúc mở trang).
// Ghi 1 điểm dữ liệu SL tồn (theo kho+item+locator) cho NGÀY HÔM NAY — nếu hôm nay đã có thì ghi đè
// (không cộng dồn nhiều lần trong cùng 1 ngày), rồi dọn bớt các điểm quá cũ (> CC_SNAPSHOT_RETENTION_DAYS ngày).
function ccCaptureInventorySnapshot(DATA){
  try{
    if(!DATA || !DATA.kho_detail) return;
    const today = ccTodayStr();
    const todayTotals = new Map(); // key -> {qty, pallets}
    Object.keys(DATA.kho_detail).forEach(kho => {
      (DATA.kho_detail[kho] || []).forEach(r => {
        const item = r[0], locator = r[2], qty = Number(r[4]) || 0;
        if(!item || !locator) return;
        const key = kho + '||' + item + '||' + locator;
        if(!todayTotals.has(key)) todayTotals.set(key, { qty: 0, pallets: 0 });
        todayTotals.get(key).qty += qty;
      });
    });
    // Đếm pallet riêng: 1 dòng dữ liệu GỐC (raw, trước khi gộp) = 1 pallet — khớp đúng quy ước
    // tính Utilization ở trang Overview. Dùng để vẽ "Biểu đồ xu hướng Utilization" theo thời gian.
    getRawRows(DATA).forEach(r => {
      const kho = r[RAW_KEY_IDX.kho], item = r[RAW_KEY_IDX.item], locator = r[RAW_KEY_IDX.locator];
      if(!kho || !item || !locator) return;
      const key = kho + '||' + item + '||' + locator;
      if(!todayTotals.has(key)) todayTotals.set(key, { qty: 0, pallets: 0 });
      todayTotals.get(key).pallets += 1;
    });

    const cutoffTime = Date.now() - CC_SNAPSHOT_RETENTION_DAYS * 24 * 3600 * 1000;
    todayTotals.forEach((val, key) => {
      const arr = invSnapshotHistory[key] || [];
      const idx = arr.findIndex(p => p.date === today);
      if(idx >= 0){ arr[idx].qty = val.qty; arr[idx].pallets = val.pallets; }
      else arr.push({ date: today, qty: val.qty, pallets: val.pallets });
      invSnapshotHistory[key] = arr.filter(p => new Date(p.date).getTime() >= cutoffTime);
    });

    // Dọn các key không còn xuất hiện trong dữ liệu hôm nay nhưng đã quá cũ toàn bộ (tránh phình vô hạn)
    Object.keys(invSnapshotHistory).forEach(key => {
      if(!invSnapshotHistory[key].length) delete invSnapshotHistory[key];
    });

    saveStateToStorage();
  }catch(err){
    console.warn('Không ghi được snapshot tồn kho:', err);
  }
}

// Trả về { score(0-100), meanQty, pointCount } đánh giá mức độ "bất thường" của SL tồn hiện tại
// so với trung bình lịch sử (CC_SNAPSHOT_RETENTION_DAYS ngày gần nhất) của cùng kho+item+locator.
// Cần tối thiểu 3 điểm dữ liệu lịch sử mới tính — nếu chưa đủ, trả điểm 0 (trung lập, không bị trừ/cộng oan).
function ccGetQtyAnomalyScore(kho, item, locator, currentQty){
  const key = kho + '||' + item + '||' + locator;
  const history = invSnapshotHistory[key] || [];
  if(history.length < 3) return { score: 0, meanQty: null, pointCount: history.length };
  const meanQty = history.reduce((s,p) => s + p.qty, 0) / history.length;
  if(meanQty <= 0) return { score: 0, meanQty, pointCount: history.length };
  const deviationRatio = Math.abs(currentQty - meanQty) / meanQty;
  const score = Math.min(100, Math.round(deviationRatio * 100));
  return { score, meanQty, pointCount: history.length };
}

function ccMoveFrequencyByItem(){
  const freq = new Map();
  if(!txState || !Array.isArray(txState.records)) return freq;
  const cutoff = Date.now() - CC_MOVE_WINDOW_DAYS * 24 * 3600 * 1000;
  txState.records.forEach(rec => {
    if(!rec || !rec.item || !rec.menuName) return;
    const dt = rec.dt ? new Date(rec.dt).getTime() : null;
    if(dt !== null && !isNaN(dt) && dt < cutoff) return;
    freq.set(rec.item, (freq.get(rec.item) || 0) + 1);
  });
  return freq;
}

function ccHasMismatch(item, locator){
  const locUp = String(locator || '').toUpperCase();
  const code = CMP_KHO_CODES.find(c => locUp.includes(c));
  if(!code) return false;
  const erp = cmpErpMaps[code], wms = cmpWmsMaps[code];
  if(!erp && !wms) return false;
  const key = item + '||' + locator;
  const eq = erp ? erp.get(key) : undefined;
  const wq = wms ? wms.get(key) : undefined;
  if(eq === undefined && wq === undefined) return false;
  if(eq === undefined || wq === undefined) return true;
  return eq !== wq;
}

// Tính điểm ưu tiên cho mọi dòng item+locator của 1 kho (đã loại PICK/Loading), sắp xếp giảm dần theo điểm
function ccComputeScoresForKho(khoLabel, allowPick){
  const invRows = ccBuildInventoryRows(allowPick);
  const moveFreq = ccMoveFrequencyByItem();
  const maxFreq = Math.max(1, ...Array.from(moveFreq.values()));
  const now = Date.now();

  // Tổng SL tồn theo kho+item+locator (gộp lại các dòng đã tách theo Cust PO) — dùng để so với lịch sử snapshot
  const itemLocatorTotalQty = new Map();
  invRows.forEach(row => {
    const k = row.kho + '||' + row.item + '||' + row.locator;
    itemLocatorTotalQty.set(k, (itemLocatorTotalQty.get(k) || 0) + row.qty);
  });

  const rowsOfKho = Array.from(invRows.values()).filter(r => r.kho === khoLabel);
  const scored = rowsOfKho.map(row => {
    const key = row.item + '||' + row.locator;
    const lastIso = lastCheckedMap[key];
    const daysSince = lastIso ? Math.floor((now - new Date(lastIso).getTime()) / (24*3600*1000)) : null;
    const agingScore = daysSince === null ? 100 : Math.min(100, Math.round((daysSince / 60) * 100));

    const freq = moveFreq.get(row.item) || 0;
    const freqScore = Math.round((freq / maxFreq) * 100);

    const mismatch = ccHasMismatch(row.item, row.locator);
    const mismatchScore = mismatch ? 100 : 0;

    const totalQtyAtLoc = itemLocatorTotalQty.get(row.kho + '||' + row.item + '||' + row.locator) || row.qty;
    const anomaly = ccGetQtyAnomalyScore(row.kho, row.item, row.locator, totalQtyAtLoc);
    const anomalyScore = anomaly.score;

    const score = Math.round(agingScore * 0.30 + freqScore * 0.30 + mismatchScore * 0.25 + anomalyScore * 0.15);

    const reasons = [];
    if(daysSince === null) reasons.push({ cls:'new', label:'Chưa từng kiểm' });
    else if(daysSince >= 30) reasons.push({ cls:'aging', label:`${daysSince} ngày chưa kiểm` });
    if(freq > 0 && freqScore >= 40) reasons.push({ cls:'fast', label:`Vận động nhanh (${freq}/${CC_MOVE_WINDOW_DAYS}d)` });
    if(mismatch) reasons.push({ cls:'mismatch', label:'Từng lệch WMS-ERP' });
    if(anomaly.pointCount >= 3 && anomalyScore >= 40){
      const dir = totalQtyAtLoc > anomaly.meanQty ? 'tăng' : 'giảm';
      reasons.push({ cls:'abnormal', label:`SL bất thường (${dir} so TB ${fmt(Math.round(anomaly.meanQty))})` });
    }
    if(!reasons.length) reasons.push({ cls:'new', label:'Ưu tiên thấp' });

    return { item: row.item, locator: row.locator, kho: row.kho, custpo: row.custpo, oqc: row.oqc, qty: row.qty, palletCount: row.palletCount, score, reasons };
  });

  scored.sort((a,b) => b.score - a.score);
  return scored;
}

// Gộp điểm theo Locator (điểm locator = điểm cao nhất trong số các mã tại vị trí đó)
function ccComputeLocatorScoresForKho(khoLabel, allowPick){
  const itemScored = ccComputeScoresForKho(khoLabel, allowPick);
  const byLoc = new Map(); // locator -> { locator, items:[], maxScore, palletCount }
  itemScored.forEach(row => {
    if(!byLoc.has(row.locator)) byLoc.set(row.locator, { locator: row.locator, items: [], maxScore: 0, palletCount: 0 });
    const entry = byLoc.get(row.locator);
    entry.items.push(row);
    entry.maxScore = Math.max(entry.maxScore, row.score);
    entry.palletCount += row.palletCount;
  });
  const list = Array.from(byLoc.values());
  list.sort((a,b) => b.maxScore - a.maxScore);
  return list;
}

// Tổng số theo 3 kiểu tính (mã hàng / locator / pallet), dùng cho nhãn thanh trượt
function ccGetKhoTotals(mode){
  const invRows = ccBuildInventoryRows();
  const totals = {};
  CC_KHO_LIST.forEach(k => totals[k.label] = 0);
  if(mode === 'locator'){
    const seen = new Set();
    invRows.forEach(row => {
      const key = row.kho + '||' + row.locator;
      if(totals[row.kho] !== undefined && !seen.has(key)){ seen.add(key); totals[row.kho]++; }
    });
  } else if(mode === 'pallet'){
    invRows.forEach(row => { if(totals[row.kho] !== undefined) totals[row.kho] += row.palletCount; });
  } else {
    invRows.forEach(row => { if(totals[row.kho] !== undefined) totals[row.kho]++; });
  }
  return totals;
}

const CC_MODE_UNIT = { item:'mã', locator:'vị trí', pallet:'pallet' };

function ccUpdateSliderLabel(code){
  const khoObj = CC_KHO_LIST.find(k => k.code === code);
  if(!khoObj) return;
  const mode = ccKhoMode[khoObj.label] || 'item';
  const totals = ccGetKhoTotals(mode);
  const total = totals[khoObj.label] || 0;
  const sppCounts = ccGetSppCounts();
  const sppCount = sppCounts[khoObj.label] || 0;
  const slider = document.getElementById('cc-slider-' + code);
  const label = document.getElementById('cc-slider-label-' + code);
  const totalEl = document.getElementById('cc-total-' + code);
  const unit = CC_MODE_UNIT[mode];
  if(totalEl) totalEl.textContent = `${fmt(total)} ${unit}` + (sppCount ? ` (${fmt(sppCount)} SPP đã loại)` : '');
  if(!slider || !label) return;
  const percent = Number(slider.value);
  const count = total ? Math.max(1, Math.ceil(total * percent / 100)) : 0;
  label.textContent = `${percent}% · ≈${fmt(count)} ${unit} / ${fmt(total)}`;
}

function ccInitKhoTotalsAndLabels(){
  CC_KHO_LIST.forEach(k => ccUpdateSliderLabel(k.code));
}

function ccSearchTerm(item, locator){
  const loc = (locator || '').trim();
  return loc ? item + ' ' + loc : item;
}

// Trạng thái sắp xếp cho bảng chế độ Mã hàng/Pallet (khác ccLocatorSortState dùng cho chế độ Locator)
// — mặc định sắp theo Locator A→Z (dễ đi theo thứ tự vị trí thực tế trong kho), bấm vào tiêu đề cột
// nào thì đổi sang sắp theo đúng cột đó, bấm lần 2 để đảo chiều.
let ccItemModeSortState = {}; // { '2B': {key:'locator', dir:1}, ... }

function ccRenderKhoResult(code, khoLabel, mode, list){
  // Dùng CHUNG đúng 1 form bảng với chế độ Locator (Locator/OQC/Cust PO/Item No/SL tồn/Kiểm thực tế
  // + nút Xác nhận) cho cả 3 chế độ Mã hàng / Locator / Pallet — để nhất quán khi kiểm tồn, không
  // còn dùng bảng rút gọn kèm nhãn lý do đề xuất như trước nữa.
  const wrap = document.getElementById('cc-loc-cards-' + code);
  const resultWrap = document.getElementById('cc-result-' + code);
  const blockWrap = document.getElementById('cc-result-block-' + code);
  const miniWrap = document.getElementById('cc-mini-wrap-' + code);
  const countEl = document.getElementById('cc-result-count-' + code);
  if(!wrap || !resultWrap) return;
  if(blockWrap) blockWrap.style.display = 'block';
  resultWrap.style.display = 'flex';
  if(miniWrap) miniWrap.style.display = 'none';
  wrap.style.display = '';

  if(countEl) countEl.textContent = mode === 'pallet'
    ? `${fmt(list.length)} mã · ${fmt(list.reduce((s,r)=>s+r.palletCount,0))} pallet`
    : `${fmt(list.length)} mã đề xuất`;
  if(!list.length){
    wrap.innerHTML = `<div style="text-align:center; color:var(--muted-2); font-style:italic; padding:14px 0;">Không có mã nào trong kho này.</div>`;
    return;
  }

  const sortState = ccItemModeSortState[code] || { key: 'locator', dir: 1 };
  const sortedList = [...list].sort((a, b) => {
    if(sortState.key === 'qty') return ((a.qty || 0) - (b.qty || 0)) * sortState.dir;
    return String(a[sortState.key] || '').localeCompare(String(b[sortState.key] || ''), 'vi', { numeric:true }) * sortState.dir;
  });

  const rowsHtml = sortedList.map(r => buildKtItemRowHtml(r, '', '', '')).join('');
  if(!rowsHtml.replace(/\s/g, '')){
    wrap.innerHTML = `<div style="text-align:center; color:var(--teal); font-weight:700; padding:14px 0;">✓ Đã kiểm xong toàn bộ danh sách này</div>`;
    return;
  }

  const sortArrow = (key) => sortState.key === key ? (sortState.dir === 1 ? '▲' : '▼') : '↕';
  wrap.innerHTML = `
    <table class="kho-detail-table kt-mode-table">
      <thead>
        <tr>
          <th class="col-kho kt-card-hide">Kho</th>
          <th class="cc-item-sort-th" data-cc-item-sort="${escAttr(code)}" data-sort-key="locator" style="cursor:pointer;" title="Bấm để sắp xếp theo Locator">Locator <span style="font-size:9px;">${sortArrow('locator')}</span></th>
          <th>OQC</th>
          <th>Cust PO</th>
          <th class="cc-item-sort-th" data-cc-item-sort="${escAttr(code)}" data-sort-key="item" style="cursor:pointer;" title="Bấm để sắp xếp theo Item No.">Item No. <span style="font-size:9px;">${sortArrow('item')}</span></th>
          <th class="cc-item-sort-th" data-cc-item-sort="${escAttr(code)}" data-sort-key="qty" style="cursor:pointer; text-align:right" title="Bấm để sắp xếp theo SL tồn">SL tồn <span style="font-size:9px;">${sortArrow('qty')}</span></th>
          <th style="text-align:left">Kiểm thực tế (6 số)</th>
        </tr>
      </thead>
      <tbody>${rowsHtml}</tbody>
    </table>`;
}
document.addEventListener('click', (e) => {
  const th = e.target.closest('.cc-item-sort-th');
  if(!th) return;
  const code = th.dataset.ccItemSort;
  const sortKey = th.dataset.sortKey;
  const khoObj = CC_KHO_LIST.find(k => k.code === code);
  const result = khoObj ? ccKhoResults[khoObj.label] : null;
  if(!result) return;
  const cur = ccItemModeSortState[code] || { key: 'locator', dir: 1 };
  ccItemModeSortState[code] = { key: sortKey, dir: (cur.key === sortKey) ? cur.dir * -1 : 1 };
  ccRenderKhoResult(code, khoObj.label, result.mode, result.list);
});

/* ---------- Che do Locator: the vi tri thu gon (mac dinh dong), mo ra la danh sach Item No.
   kem o "Kiem thuc te" + nut "Xac nhan" cho tung ma - dung lai dung cau truc dong & cac
   trinh xu ly su kien (kt-input / kt-confirm-btn / kt-calc-toggle) da co san cho tinh nang
   kiem ton kho, chi khac la gio duoc nhom theo tung the vi tri thay vi 1 bang phang dai. ---------- */
// Trộn 1 pallet vừa quét (số lượng palletQty) vào bộ 3 cặp (số lượng × SL/pallet) đang nhập —
// nếu đã có 1 cặp cùng SL/pallet thì +1 vào số lượng cặp đó, chưa có thì tìm cặp còn trống để
// gán, hết chỗ trống (đã đủ 3 loại SL pallet khác nhau) thì cộng dồn tạm vào cặp cuối.
// Trộn 1 pallet vừa quét vào bộ 3 cặp (số lượng × SL/pallet). Ô 1 và Ô 2 dành riêng cho 2 loại
// SL/pallet gặp đầu tiên (đếm số lượng chính xác từng cỡ). Từ loại SL thứ 3 trở đi, TẤT CẢ dồn vào
// Ô 3 dưới dạng CỘNG DỒN TỔNG (số lượng luôn giữ = 1, SL/pallet = tổng cộng dồn) — đảm bảo tổng
// cuối cùng luôn ĐÚNG TUYỆT ĐỐI dù ô nhập chỉ có 3 cặp, kể cả khi gặp quá 3 cỡ pallet khác nhau.
// Cái giá phải trả: từ pallet thứ 3 khác cỡ trở đi, Ô 3 không còn đại diện cho đúng 1 cỡ pallet cụ
// thể — chỉ Ô 1 và Ô 2 là chính xác từng cỡ, cần đối chiếu tay nếu muốn biết chi tiết từng pallet lẻ.
function mergePalletIntoKtTally(tally, palletQty){
  const t = tally ? tally.slice() : [0,1,0,1,0,1];
  // Ô 1, Ô 2: trùng SL đã có -> +1 số lượng; còn trống -> gán mới
  for(let i=0;i<2;i++){
    const cIdx = i*2, mIdx = i*2+1;
    if(t[cIdx] > 0 && t[mIdx] === palletQty){ t[cIdx] += 1; return t; }
  }
  for(let i=0;i<2;i++){
    const cIdx = i*2, mIdx = i*2+1;
    if(!t[cIdx]){ t[cIdx] = 1; t[mIdx] = palletQty; return t; }
  }
  // Ô 3: còn trống -> gán mới; trùng đúng giá trị hiện có -> +1 số lượng bình thường
  if(!t[4]){ t[4] = 1; t[5] = palletQty; return t; }
  if(t[5] === palletQty){ t[4] += 1; return t; }
  // Gặp loại SL thứ 4 trở đi -> cộng dồn thẳng vào tổng của Ô 3 (không đếm số lượng nữa)
  const slot3Total = t[4] * t[5];
  t[4] = 1;
  t[5] = slot3Total + palletQty;
  return t;
}

function ccOqcNormalize(oqc){
  const v = (oqc || '').toUpperCase();
  if(v.includes('PASS')) return 'PASS';
  if(v.includes('NG')) return 'NG';
  return 'Khac';
}

function ccRowKeyForItem(r){
  const oqcNorm = ccOqcNormalize(r.oqc);
  return r.item + '|' + (r.custpo || '') + '|' + r.locator + '|' + oqcNorm + '|' + r.qty;
}

// Xoá HẲN 1 dòng khỏi "Đề xuất kiểm hôm nay" (không phải "Xác nhận" — xoá thẳng, dùng khi 1 dòng bị
// tạo sai, VD: quét nhầm sang locator khác mà quên bấm "Đổi vị trí" nên hệ thống tự tạo 1 dòng mới
// không cần thiết). Dọn dẹp theo đúng 3 chỗ liên quan tới dòng này: bản nháp KT đang nhập
// (ktInputValues), chính dòng đó trong ccKhoResults, và mọi GI No. đã quét gắn với dòng này — xoá
// luôn khỏi scannedGiSet để có thể quét lại các GI đó vào đúng vị trí thực tế, không bị báo trùng.
// Trả về số GI No. đã xoá kèm theo (để hiện trong thông báo), hoặc -1 nếu không tìm thấy dòng.
function ccDeleteRow(khoLabel, rowKey){
  const result = ccKhoResults[khoLabel];
  let removed = false;
  if(result){
    if(result.mode === 'locator'){
      result.list.forEach(grp => {
        const idx = grp.items.findIndex(r => ccRowKeyForItem(r) === rowKey);
        if(idx !== -1){ grp.items.splice(idx, 1); removed = true; }
      });
    } else {
      const idx = result.list.findIndex(r => ccRowKeyForItem(r) === rowKey);
      if(idx !== -1){ result.list.splice(idx, 1); removed = true; }
    }
  }
  // Dòng "sai vị trí" tự thêm khi quét QR (scannedExtraRows) không nằm trong ccKhoResults — trước đây
  // hàm này không hề tìm ở đây, nên bấm 🗑 trên đúng dạng dòng này không xoá được gì (âm thầm không
  // làm gì, dữ liệu vẫn còn sót lại).
  const extraList = scannedExtraRows[khoLabel];
  if(extraList){
    const exIdx = extraList.findIndex(r => ccRowKeyForItem(r) === rowKey);
    if(exIdx !== -1){
      extraList.splice(exIdx, 1);
      removed = true;
      if(!extraList.length) delete scannedExtraRows[khoLabel];
    }
  }
  if(!removed) return -1;
  delete ktInputValues[rowKey];
  delete confirmedKiemTonItems[rowKey];
  const keepLog = [];
  let removedGiCount = 0;
  giScanLog.forEach(g => {
    if(g.rowKey === rowKey){ scannedGiSet.delete(g.gi); _deletedGiKeys.add(g.gi); removedGiCount++; }
    else keepLog.push(g);
  });
  giScanLog = keepLog;
  if(typeof updateQrGiClearBtn === 'function') updateQrGiClearBtn();
  return removedGiCount;
}

// Danh sách locator hiện có trong danh sách "Đề xuất kiểm hôm nay" của 1 kho — dùng cho ô xổ xuống
// Locator của dòng "sai vị trí" tự thêm khi quét QR.
function ccAllLocatorsInResult(khoLabel){
  const result = ccKhoResults[khoLabel];
  if(!result) return [];
  const flat = result.mode === 'locator' ? result.list.flatMap(g => g.items) : result.list;
  return [...new Set(flat.map(x => x.locator).filter(Boolean))].sort();
}

// So màu kết quả "KT =" (số vừa kiểm được) với "SL tồn" (số hệ thống) ngay khi vừa nhìn là biết đủ/
// thiếu/dư, không cần tự trừ nhẩm: XANH (var(--teal)) = khớp đúng, ĐỎ (var(--red)) = kiểm thiếu so
// với hệ thống, CAM (var(--amber-bright)) = kiểm dư so với hệ thống.
function ktResultColor(total, qty){
  const t = Math.round(Number(total) || 0);
  const q = Math.round(Number(qty) || 0);
  if(t === q) return 'var(--teal)';
  return t < q ? 'var(--red)' : 'var(--amber-bright)';
}

function buildKtItemRowHtml(r, rowStyle, groupCls, locBorderStyle){
  const rowKey = ccRowKeyForItem(r);
  if(confirmedKiemTonItems[rowKey]) return ''; // Da xac nhan roi -> khong hien lai

  const ktSaved = ktInputValues[rowKey];
  const ktIv0 = ktSaved && ktSaved[0] !== undefined ? ktSaved[0] : 0;
  const ktIv1 = ktSaved && ktSaved[1] !== undefined ? ktSaved[1] : 1;
  const ktIv2 = ktSaved && ktSaved[2] !== undefined ? ktSaved[2] : 0;
  const ktIv3 = ktSaved && ktSaved[3] !== undefined ? ktSaved[3] : 1;
  const ktIv4 = ktSaved && ktSaved[4] !== undefined ? ktSaved[4] : 0;
  const ktIv5 = ktSaved && ktSaved[5] !== undefined ? ktSaved[5] : 1;
  // Locator ở đầu LUÔN là vị trí ĐANG QUÉT/ĐANG ĐỨNG (r.locator) — đúng vị trí thực tế ngoài kho.
  // Nếu là dòng "sai vị trí/sai OQC" (isScannedExtra), ghi chú thêm những gì hệ thống WMS đang ghi
  // nhận (vị trí và/hoặc OQC) ngay bên dưới, để người kiểm biết hệ thống đang lưu ra sao mà không
  // cần tra lại — và badge cảnh báo hiện đúng loại sai lệch (vị trí, OQC, hoặc cả hai).
  const wmsNoteParts = [];
  if(r.isWrongLocation && r.wmsLocator) wmsNoteParts.push(`Vị trí <b>${escHtml(r.wmsLocator)}</b>`);
  if(r.isWrongOqc && r.wmsOqc) wmsNoteParts.push(`OQC <b>${escHtml(r.wmsOqc)}</b>`);
  const wmsNoteHtml = wmsNoteParts.length
    ? `<div class="scanned-extra-wms-note" title="Thông tin hệ thống WMS đang ghi nhận cho mã này">WMS: ${wmsNoteParts.join(' · ')}</div>`
    : '';
  const mismatchBadgeText = r.isWrongLocation && r.isWrongOqc ? '⚠ Sai vị trí & OQC' : (r.isWrongLocation ? '⚠ Sai vị trí' : (r.isWrongOqc ? '⚠ Sai OQC' : ''));
  const locatorCellHtml = r.isScannedExtra
    ? `<select class="scanned-extra-loc-select">${ccAllLocatorsInResult(r.kho).map(loc => `<option value="${escAttr(loc)}"${loc === r.locator ? ' selected' : ''}>${escHtml(loc)}</option>`).join('')}</select>${wmsNoteHtml}`
    : escHtml(r.locator);

  return `
    <tr class="${(groupCls || '').trim()}${r.isScannedExtra ? ' row-scanned-extra' : ''}"${rowStyle || ''} data-wrong-location="${r.isWrongLocation ? '1' : '0'}" data-wms-locator="${escAttr(r.wmsLocator || '')}" data-wrong-oqc="${r.isWrongOqc ? '1' : '0'}" data-wms-oqc="${escAttr(r.wmsOqc || '')}" data-kho="${escAttr(r.kho || '')}">
      <td class="col-kho kt-card-hide" data-label="Kho">${escHtml((r.kho || '').replace('Kho ',''))}</td>
      <td class="loc-group-cell" data-label="Locator"${locBorderStyle || ''}>${locatorCellHtml}</td>
      <td data-label="OQC">${oqcBadge(r.oqc)}${r.isScannedExtra ? ` <span class="scanned-extra-badge" title="Được tự thêm khi quét QR — mã này không có sẵn trong danh sách kiểm tại vị trí/OQC hệ thống ghi nhận">${mismatchBadgeText}</span>` : ''}</td>
      <td data-label="Cust PO">${escHtml(r.custpo || '')}</td>
      <td data-label="Item No.">${escHtml(r.item)}</td>
      <td class="num" data-label="SL tồn">${fmt(r.qty)}</td>
      <td class="kt-calc-cell">
        <div class="kt-calc-row">
          <span style="color:var(--text); font-weight:700; margin-right:4px;">KT =</span>
          <span class="kt-result" style="font-weight:700; color:${ktResultColor(ktIv0*ktIv1 + ktIv2*ktIv3 + ktIv4*ktIv5, r.qty)}; min-width:40px; text-align:right; display:inline-block;">${fmt(ktIv0*ktIv1 + ktIv2*ktIv3 + ktIv4*ktIv5)}</span>
          <button type="button" class="kt-calc-toggle"><span>Nhập số liệu</span><span class="kt-calc-toggle-arrow">▾</span></button>
          <span class="kt-calc-inputs">
            <span style="margin: 0 4px; color:var(--muted-2);">|</span>
            <span style="color:var(--muted-2);">(</span>
            <input type="number" class="kt-input" value="${ktIv0}" data-default="0" style="width:35px; padding:2px; border:1px solid var(--line); border-radius:3px; text-align:center; font-size:11px; box-sizing:border-box;">
            <span style="color:var(--muted-2);">×</span>
            <input type="number" class="kt-input" value="${ktIv1}" data-default="1" style="width:35px; padding:2px; border:1px solid var(--line); border-radius:3px; text-align:center; font-size:11px; box-sizing:border-box;">
            <span style="color:var(--muted-2);">) + (</span>
            <input type="number" class="kt-input" value="${ktIv2}" data-default="0" style="width:35px; padding:2px; border:1px solid var(--line); border-radius:3px; text-align:center; font-size:11px; box-sizing:border-box;">
            <span style="color:var(--muted-2);">×</span>
            <input type="number" class="kt-input" value="${ktIv3}" data-default="1" style="width:35px; padding:2px; border:1px solid var(--line); border-radius:3px; text-align:center; font-size:11px; box-sizing:border-box;">
            <span style="color:var(--muted-2);">) + (</span>
            <input type="number" class="kt-input" value="${ktIv4}" data-default="0" style="width:35px; padding:2px; border:1px solid var(--line); border-radius:3px; text-align:center; font-size:11px; box-sizing:border-box;">
            <span style="color:var(--muted-2);">×</span>
            <input type="number" class="kt-input" value="${ktIv5}" data-default="1" style="width:35px; padding:2px; border:1px solid var(--line); border-radius:3px; text-align:center; font-size:11px; box-sizing:border-box;">
            <span style="color:var(--muted-2);">)</span>
          </span>
          <button class="kt-confirm-btn" style="margin-left:8px; padding:2px 10px; border-radius:4px; border:1px solid var(--teal); background:var(--teal); color:white; font-size:11px; cursor:pointer; transition:all 0.2s; white-space:nowrap;" data-locked="false">Xác nhận</button>
          <button type="button" class="kt-delete-btn" title="Xoá hẳn dòng này khỏi danh sách đề xuất kiểm (VD: dòng bị tạo sai do quét nhầm sang locator khác mà quên đổi vị trí) — các GI No. đã quét gắn với dòng này cũng sẽ được xoá khỏi lịch sử quét để có thể quét lại." style="margin-left:4px; padding:2px 8px; border-radius:4px; border:1px solid var(--red); background:transparent; color:var(--red); font-size:11px; cursor:pointer; transition:all 0.2s; white-space:nowrap;">🗑</button>
        </div>
      </td>
    </tr>`;
}

// Bảng phẳng (giống bảng "Kiểm tồn kho" cũ) — hiện tất cả các dòng cùng lúc, không cần bấm mở
// từng vị trí, chỉ tô màu + viền trái theo từng nhóm Locator để dễ phân biệt khi kiểm lần lượt.
let ccLocatorSortState = {}; // { '2B': {dir:1}, '3A': {...}, '3B': {...} } — 1 = A→Z, -1 = Z→A

function ccRenderLocatorCards(code, khoLabel, list){
  const wrap = document.getElementById('cc-loc-cards-' + code);
  const resultWrap = document.getElementById('cc-result-' + code);
  const blockWrap = document.getElementById('cc-result-block-' + code);
  const miniWrap = document.getElementById('cc-mini-wrap-' + code);
  const countEl = document.getElementById('cc-result-count-' + code);
  if(!wrap || !resultWrap) return;
  if(blockWrap) blockWrap.style.display = 'block';
  resultWrap.style.display = 'flex';
  if(miniWrap) miniWrap.style.display = 'none';
  wrap.style.display = '';

  if(countEl) countEl.textContent = `${fmt(list.length)} vị trí`;
  if(!list.length){
    wrap.innerHTML = `<div style="text-align:center; color:var(--muted-2); font-style:italic; padding:14px 0;">Không có vị trí nào trong kho này.</div>`;
    return;
  }

  // Sắp xếp các vị trí theo Locator (mặc định A→Z) — bấm vào tiêu đề "Locator" để đổi chiều.
  const sortDir = (ccLocatorSortState[code] && ccLocatorSortState[code].dir) || 1;
  const sortedList = [...list].sort((a, b) => String(a.locator || '').localeCompare(String(b.locator || ''), 'vi', { numeric: true }) * sortDir);

  const locatorColorMap = new Map();
  const rowsHtml = sortedList.map(loc => {
    if(!locatorColorMap.has(loc.locator)) locatorColorMap.set(loc.locator, GROUP_COLOR_PALETTE[locatorColorMap.size % GROUP_COLOR_PALETTE.length]);
    const locColor = locatorColorMap.get(loc.locator);
    const rowStyle = ` style="background:${hexToRgba(locColor, 0.1)};"`;
    const locBorderStyle = ` style="border-left-color:${locColor};"`;
    const itemsHtml = loc.items.map((it) => buildKtItemRowHtml(it, rowStyle, '', locBorderStyle)).join('');
    if(!itemsHtml.replace(/\s/g, '')) return ''; // Vị trí này đã kiểm/xác nhận hết -> không hiện tiêu đề trống
    const headerRow = `<tr class="kt-loc-header-row"><td colspan="7" style="background:${hexToRgba(locColor, 0.1)}; border-left:4px solid ${locColor};">
        <div class="kt-loc-header-inner">
          <span class="kt-loc-header-name">📍 ${escHtml(loc.locator)}</span>
          <button type="button" class="kt-confirm-locator-btn" data-loc-name="${escAttr(loc.locator)}" title="Xác nhận TẤT CẢ các dòng đang hiện ở vị trí này, dùng đúng số liệu đang nhập hiện tại của từng dòng (dòng nào chưa nhập gì thì tính bằng 0)">✓✓</button>
        </div>
      </td></tr>`;
    return headerRow + itemsHtml;
  }).join('');

  if(!rowsHtml.replace(/\s/g, '')){
    wrap.innerHTML = `<div style="text-align:center; color:var(--teal); font-weight:700; padding:14px 0;">✓ Đã kiểm xong toàn bộ danh sách này</div>`;
    return;
  }

  const arrow = sortDir === 1 ? '▲' : '▼';
  wrap.innerHTML = `
    <table class="kho-detail-table kt-mode-table">
      <thead>
        <tr>
          <th class="col-kho kt-card-hide">Kho</th>
          <th class="cc-loc-sort-th" data-cc-loc-sort="${escAttr(code)}" style="cursor:pointer;" title="Bấm để đổi chiều sắp xếp theo Locator">Locator <span style="font-size:9px;">${arrow}</span></th>
          <th>OQC</th>
          <th>Cust PO</th>
          <th>Item No.</th>
          <th style="text-align:right">SL tồn</th>
          <th style="text-align:left">Kiểm thực tế (6 số)</th>
        </tr>
      </thead>
      <tbody>${rowsHtml}</tbody>
    </table>`;
}
document.addEventListener('click', (e) => {
  const th = e.target.closest('.cc-loc-sort-th');
  if(!th) return;
  const code = th.dataset.ccLocSort;
  const khoLabel = CC_KHO_LIST.find(k => k.code === code)?.label;
  const result = khoLabel ? ccKhoResults[khoLabel] : null;
  if(!result) return;
  const cur = ccLocatorSortState[code] || { dir: 1 };
  ccLocatorSortState[code] = { dir: cur.dir * -1 };
  ccRenderLocatorCards(code, khoLabel, result.list);
});

// Ô nhập "Kiểm thực tế (6 số)" — bấm mũi tên Lên/Xuống để nhảy sang đúng ô cùng vị trí ở dòng
// trên/dưới (giống di chuyển giữa các ô trong Excel), thay vì tăng/giảm số mặc định của input.
document.addEventListener('keydown', (e) => {
  if(!e.target.classList || !e.target.classList.contains('kt-input')) return;
  if(e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
  const currentTd = e.target.closest('td.kt-calc-cell');
  if(!currentTd) return;
  const inputsInRow = Array.from(currentTd.querySelectorAll('.kt-input'));
  const idx = inputsInRow.indexOf(e.target);
  if(idx === -1) return;
  const tr = e.target.closest('tr');
  if(!tr) return;
  const targetTr = e.key === 'ArrowUp' ? tr.previousElementSibling : tr.nextElementSibling;
  e.preventDefault(); // luôn chặn hành vi tăng/giảm số mặc định của input, kể cả khi ở dòng đầu/cuối
  if(!targetTr) return;
  const targetTd = targetTr.querySelector('td.kt-calc-cell');
  if(!targetTd) return;
  targetTd.classList.add('expanded'); // đảm bảo hiện ô nhập kể cả khi đang thu gọn ở chế độ thẻ mobile
  const targetInputs = targetTd.querySelectorAll('.kt-input');
  if(targetInputs[idx]){
    targetInputs[idx].focus();
    targetInputs[idx].select();
  }
});

// Sau khi bảng chính re-render (VD: sau khi Xác nhận/Mở khoá 1 dòng), làm mới lại bảng
// (chế độ Locator) đang hiển thị, để dòng vừa xác nhận biến mất khỏi bảng tương ứng.
function ccRefreshLocatorCardsIfActive(){
  CC_KHO_LIST.forEach(k => {
    const result = ccKhoResults[k.label];
    if(!result) return;
    // TRƯỚC ĐÂY chỉ vẽ lại đúng chế độ Locator — chế độ Mã hàng/Pallet (ccRenderKhoResult) bị bỏ
    // quên, nên sau khi Xác nhận/Xoá 1 dòng ở chế độ Mã hàng, dòng đó không tự cập nhật/biến mất như
    // bên Locator, phải chuyển tab đi rồi quay lại mới thấy đúng. Giờ làm mới đúng theo chế độ hiện
    // tại của từng kho, đồng bộ logic giữa cả 2 chế độ.
    if(result.mode === 'locator') ccRenderLocatorCards(k.code, k.label, result.list);
    else ccRenderKhoResult(k.code, k.label, result.mode, result.list);
  });
}

// Khoá/mở khoá 1 thẻ kho (tab chế độ + thanh trượt + nút Tạo danh sách + Tự chọn) — xám lại, không
// cho thao tác nữa khi kho đó ĐÃ có danh sách "Đề xuất kiểm hôm nay", tránh bấm nhầm tạo đè/tạo lại
// làm mất công sức nhập liệu đang dở. Chỉ mở lại được sau khi bấm "Xoá danh sách" cho đúng kho đó.
function ccSetCardLocked(khoLabel, locked){
  const card = document.querySelector(`.cc-kho-card[data-kho="${CSS.escape(khoLabel)}"]`);
  if(!card) return;
  card.classList.toggle('cc-locked', locked);
  card.querySelectorAll('.cc-mode-tab, .cc-kho-slider, .cc-gen-btn, .cc-custom-btn').forEach(el => {
    el.disabled = locked;
  });
}

// Khôi phục lại các danh sách "Tạo danh sách" đã tạo trước đó (lưu trong trình duyệt), để không bị
// mất khi tải lại trang — chỉ hiển thị lại đúng dữ liệu đã tính, không tính lại từ đầu.
function ccRestoreResultsFromStorage(saved){
  // Gán theo ĐÚNG thứ tự khoá đã lưu (Object.keys(saved) giữ nguyên thứ tự JSON.parse trả về) — TRƯỚC
  // ĐÂY dựng lại ccKhoResults theo thứ tự CỐ ĐỊNH của CC_KHO_LIST (2B→3A→3B), khiến JSON.stringify()
  // sau đó (mỗi lần render/lưu) ra chuỗi khác thứ tự khoá so với bản đã lưu — dù nội dung y hệt — nên
  // luôn bị báo nhầm "có thay đổi chưa lưu (Đề xuất kiểm hôm nay)" ngay khi vừa mở lại trang.
  if(saved){
    Object.keys(saved).forEach(khoLabel => {
      const result = saved[khoLabel];
      if(!result || !result.list || !result.list.length) return;
      ccKhoResults[khoLabel] = result;
    });
  }
  // LUÔN xét ĐỦ cả 3 kho (kể cả khi "saved" không có/rỗng) — không chỉ những kho có trong "saved" —
  // để kho nào KHÔNG (còn) có danh sách cũng được vẽ lại đúng về trạng thái RỖNG. Trước đây hàm này
  // chỉ XỬ LÝ (vẽ) những kho CÓ kết quả, bỏ qua hẳn kho nào không có — nên khi initDashboard() chạy
  // lại giữa phiên (VD: máy khác vừa "Xoá danh sách" 1 kho và đồng bộ Cloud xong), khối kết quả CŨ
  // của kho đó vẫn còn nguyên trên MÀN HÌNH (không ai bảo nó ẩn đi/xoá đi cả), dù ccKhoResults (biến)
  // đã đúng là không còn kho đó nữa — y hệt lỗi đã sửa ở renderConfirmedList()/"Đã xác nhận".
  CC_KHO_LIST.forEach(k => {
    const result = ccKhoResults[k.label];
    if(!result){
      const blockWrap = document.getElementById('cc-result-block-' + k.code);
      const tbody = document.getElementById('cc-tbody-' + k.code);
      const cardsWrap = document.getElementById('cc-loc-cards-' + k.code);
      if(blockWrap) blockWrap.style.display = 'none';
      if(tbody) tbody.innerHTML = '';
      if(cardsWrap) cardsWrap.innerHTML = '';
      ccSetCardLocked(k.label, false);
      return;
    }
    ccKhoMode[k.label] = result.mode;
    const card = document.querySelector(`.cc-kho-card[data-kho="${CSS.escape(k.label)}"]`);
    if(card){
      card.dataset.mode = result.mode;
      card.querySelectorAll('.cc-mode-tab').forEach(b => b.classList.toggle('active', b.dataset.mode === result.mode));
    }
    ccUpdateSliderLabel(k.code);
    if(result.mode === 'locator') ccRenderLocatorCards(k.code, k.label, result.list);
    else ccRenderKhoResult(k.code, k.label, result.mode, result.list);
    ccSetCardLocked(k.label, true);
  });
}

// Bấm 1 tab chế độ (Mã hàng / Locator / Pallet) trên 1 thẻ kho
document.addEventListener('click', function(e){
  const tab = e.target.closest('.cc-mode-tab');
  if(!tab) return;
  const khoLabel = tab.dataset.kho;
  const mode = tab.dataset.mode;
  const card = tab.closest('.cc-kho-card');
  if(!card) return;
  ccKhoMode[khoLabel] = mode;
  card.dataset.mode = mode;
  card.querySelectorAll('.cc-mode-tab').forEach(b => b.classList.toggle('active', b === tab));
  const code = card.dataset.khoCode;
  ccUpdateSliderLabel(code);
  // Ẩn kết quả cũ (thuộc chế độ trước) để tránh hiểu nhầm
  const resultWrap = document.getElementById('cc-result-' + code);
  if(resultWrap) resultWrap.style.display = 'none';
  const blockWrap = document.getElementById('cc-result-block-' + code);
  if(blockWrap) blockWrap.style.display = 'none';
});

// Gộp nhiều thay đổi liên tiếp ở khu "Đề xuất kiểm hôm nay" (Tạo danh sách / quét QR...) thành 1
// request lưu Cloud duy nhất — giống hệt cơ chế schedulePlanAutoSaveToCloud() khi tải Plan, để
// KHÔNG cần bấm nút "Lưu" ở đầu trang mà dữ liệu vẫn tự lên Cloud ngay.
let _ccAutoSaveTimer = null;
function scheduleCcAutoSaveToCloud(){
  if(typeof CloudVault === 'undefined' || !CloudVault.url || !CloudVault.token) return;
  clearTimeout(_ccAutoSaveTimer);
  const statusEl = document.getElementById('upload-status');
  if(statusEl){ statusEl.className = 'upload-status'; statusEl.textContent = '● Vừa tạo/cập nhật danh sách kiểm — chuẩn bị tự lưu lên Cloud…'; }
  _ccAutoSaveTimer = setTimeout(async () => {
    try{
      await CloudVault.writeMerge([STORAGE_KEY_CCRESULTS, STORAGE_KEY_KT_INPUTS]);
      if(typeof clearUnsavedChanges === 'function') clearUnsavedChanges();
      if(statusEl){ statusEl.className = 'upload-status ok'; statusEl.textContent = `✓ Danh sách kiểm đã lưu lên Cloud lúc ${fmtDateTime(new Date())} (${fmtBytes(CloudVault._lastWriteBytes)}).`; }
    }catch(err){
      if(statusEl){ statusEl.className = 'upload-status err'; statusEl.textContent = `⚠ Danh sách kiểm CHƯA LƯU ĐƯỢC lên Cloud: ${err.message} — bấm nút "Lưu" ở đầu trang để thử lại.`; }
    }
  }, 2000);
}

// Bấm "Tạo danh sách" trên 1 thẻ kho -> tính theo chế độ + % đang chọn, hiển thị mini-table
document.addEventListener('click', function(e){
  const btn = e.target.closest('.cc-gen-btn');
  if(!btn) return;
  const khoLabel = btn.dataset.kho;
  const khoObj = CC_KHO_LIST.find(k => k.label === khoLabel);
  if(!khoObj) return;
  if(!currentData || !currentData.kho_detail){
    const emptyEl = document.getElementById('cc-suggest-empty');
    if(emptyEl) emptyEl.style.display = 'block';
    return;
  }
  const mode = ccKhoMode[khoLabel] || 'item';
  const totals = ccGetKhoTotals(mode);
  const total = totals[khoLabel] || 0;
  const slider = document.getElementById('cc-slider-' + khoObj.code);
  const percent = slider ? Number(slider.value) : 20;
  const target = total ? Math.max(1, Math.ceil(total * percent / 100)) : 0;

  let list;
  if(mode === 'locator'){
    list = ccComputeLocatorScoresForKho(khoLabel).slice(0, target);
  } else if(mode === 'pallet'){
    const scored = ccComputeScoresForKho(khoLabel);
    list = [];
    let cum = 0;
    for(const row of scored){
      if(cum >= target) break;
      list.push(row);
      cum += row.palletCount;
    }
  } else {
    list = ccComputeScoresForKho(khoLabel).slice(0, target);
  }

  ccKhoResults[khoLabel] = { mode, list };
  if(mode === 'locator') ccRenderLocatorCards(khoObj.code, khoLabel, list);
  else ccRenderKhoResult(khoObj.code, khoLabel, mode, list);
  ccSetCardLocked(khoLabel, true);
  saveStateToStorage();
  scheduleCcAutoSaveToCloud();
});

// Kéo thanh trượt -> cập nhật nhãn % / số lượng tương ứng theo thời gian thực
document.addEventListener('input', function(e){
  if(!e.target.classList || !e.target.classList.contains('cc-kho-slider')) return;
  const code = e.target.id.replace('cc-slider-', '');
  ccUpdateSliderLabel(code);
});


// Bấm "Xuất Excel" trên 1 thẻ kho -> xuất danh sách vừa tạo ra file .xlsx để in
// Sắp xếp theo Locator A→Z, tách riêng từng mã thành 1 dòng (kể cả chế độ Locator) để điền số lượng kiểm
// theo từng mã, kẻ khung toàn bộ bảng, viền đậm phân tách giữa các nhóm Locator.
document.addEventListener('click', function(e){
  const btn = e.target.closest('[data-cc-export-kho]');
  if(!btn) return;
  const khoLabel = btn.dataset.ccExportKho;
  const result = ccKhoResults[khoLabel];
  if(!result || !result.list.length){ alert('Chưa có danh sách để xuất — bấm "Tạo danh sách" trước.'); return; }
  ccExportKhoExcel(khoLabel, result);
});

// Xoá danh sách "Đề xuất kiểm hôm nay" đã tạo cho ĐÚNG 1 kho — ẩn khối kết quả, mở khoá lại thẻ kho
// đó để có thể "Tạo danh sách" lại từ đầu. Dùng chung cho nút "Xoá danh sách" và cho nút "Lưu" ở
// khu "Danh sách đã xác nhận" (lưu xong thì reset luôn để bắt đầu đợt kiểm kê mới).
function ccClearKhoResult(khoLabel){
  const code = CC_KHO_LIST.find(k => k.label === khoLabel)?.code;
  // Dọn luôn các số liệu KT nháp thuộc đúng danh sách sắp xoá của kho này — tránh việc lỡ trùng
  // đúng item/locator/PO/SL ở đợt "Tạo danh sách" sau sẽ tự điền sẵn số cũ, gây nhầm lẫn.
  const result = ccKhoResults[khoLabel];
  if(result){
    const flatItems = result.mode === 'locator' ? result.list.flatMap(g => g.items) : result.list;
    flatItems.forEach(r => { delete ktInputValues[ccRowKeyForItem(r)]; });
  }
  // Dọn luôn các dòng "sai vị trí" tự thêm khi quét QR (scannedExtraRows) của đúng kho này — trước
  // đây KHÔNG có chỗ nào xoá mảng này, nên các dòng tự thêm cứ tồn tại mãi và lẫn cả sang đợt
  // "Tạo danh sách" mới, hiện lại y như dữ liệu cũ.
  if(scannedExtraRows[khoLabel]){
    scannedExtraRows[khoLabel].forEach(r => { delete ktInputValues[ccRowKeyForItem(r)]; });
    delete scannedExtraRows[khoLabel];
  }
  delete ccKhoResults[khoLabel];
  if(code){
    const blockWrap = document.getElementById('cc-result-block-' + code);
    const tbody = document.getElementById('cc-tbody-' + code);
    const cardsWrap = document.getElementById('cc-loc-cards-' + code);
    if(blockWrap) blockWrap.style.display = 'none';
    if(tbody) tbody.innerHTML = '';
    if(cardsWrap) cardsWrap.innerHTML = '';
  }
  ccSetCardLocked(khoLabel, false);
}

// Bấm "Xoá danh sách" trên 1 thẻ kho -> xoá danh sách "Đề xuất kiểm hôm nay" đã tạo cho ĐÚNG kho đó
// (không đụng tới các kho khác), ẩn khối kết quả đi để có thể "Tạo danh sách" lại từ đầu.
document.addEventListener('click', function(e){
  const btn = e.target.closest('[data-cc-clear-kho]');
  if(!btn) return;
  const khoLabel = btn.dataset.ccClearKho;
  const code = CC_KHO_LIST.find(k => k.label === khoLabel)?.code;
  if(!ccKhoResults[khoLabel] && !(code && document.getElementById('cc-result-block-' + code))) return;
  if(!confirm(`Xoá danh sách "Đề xuất kiểm hôm nay" đã tạo cho ${khoLabel}?`)) return;
  // Huỷ hẹn giờ tự lưu riêng (_ccAutoSaveTimer, dùng khi "Tạo danh sách") nếu còn đang chờ từ thao
  // tác NGAY TRƯỚC đó — cùng lý do đã sửa ở nút "Lưu"/"Đặt lại toàn bộ": tránh 1 hẹn giờ cũ tự chạy
  // sau khi đã xoá ở đây.
  if(typeof _ccAutoSaveTimer !== 'undefined' && _ccAutoSaveTimer){
    clearTimeout(_ccAutoSaveTimer);
    _ccAutoSaveTimer = null;
  }
  ccClearKhoResult(khoLabel);
  saveStateToStorage();
  // Y HỆT lúc xoá Plan — nếu không tự đẩy lên Cloud ngay, Cloud vẫn còn giữ bản danh sách CŨ (chưa
  // xoá), lần đọc lại tiếp theo (tải lại trang, đổi thiết bị, hay Realtime) sẽ kéo về làm danh sách
  // "sống lại" y như cũ dù đã bấm Xoá.
  scheduleAutoSaveToCloud('cc', [STORAGE_KEY_CCRESULTS, STORAGE_KEY_KT_INPUTS, STORAGE_KEY_SCANNED_EXTRA], 'Danh sách "Đề xuất kiểm hôm nay"');
});

// Bấm "🔄 Đặt lại toàn bộ" (góc trên phải panel "Đề xuất kiểm hôm nay") — dọn SẠCH mọi dữ liệu còn
// sót của đợt kiểm kê trước, CẢ 2 bảng (Đề xuất kiểm hôm nay + Đã xác nhận): không chỉ xoá theo đúng
// các dòng đang có trong danh sách hiện tại (như ccClearKhoResult vẫn làm), mà xoá TRẮNG hẳn
// ktInputValues/scannedExtraRows/confirmedKiemTonItems — vì rowKey được ghép từ item+custpo+locator+
// oqc+qty (KHÔNG có dấu thời gian), nên nếu đợt kiểm kê mới trùng đúng SL với đợt cũ, số liệu cũ sẽ
// tự điền/hiện lại y như đợt trước — chỉ xoá trắng toàn bộ mới chắc chắn dọn hết, kể cả các dòng
// "mồ côi" còn sót từ rất lâu trước. Đẩy thẳng lên Cloud ngay sau khi xoá (writeAll — ghi đè TOÀN BỘ
// state), để lần "Làm mới dữ liệu" tiếp theo (kể cả từ máy/ca khác) không kéo lại đúng bản CŨ đã xoá.
document.getElementById('btn-reset-kiemke-all').addEventListener('click', async () => {
  const btn = document.getElementById('btn-reset-kiemke-all');
  const cloudActive = typeof CloudVault !== 'undefined' && CloudVault.url && CloudVault.token;

  // Huỷ các lượt tự lưu kiểm tồn còn đang chờ trước khi reset. Nếu không, một timer cũ (được tạo
  // từ lần Xác nhận/Quét QR ngay trước đó) có thể chạy sau thao tác reset và gửi lại trạng thái
  // không mong muốn đúng lúc Cloud/realtime đang đồng bộ.
  ['cc','confirm','qrscan'].forEach(k => {
    if(typeof _autoSaveTimers !== 'undefined' && _autoSaveTimers[k]){
      clearTimeout(_autoSaveTimers[k]);
      _autoSaveTimers[k] = null;
    }
    if(typeof _pendingAutoSaveKeys !== 'undefined') _pendingAutoSaveKeys.delete(k);
  });
  if(typeof _ccAutoSaveTimer !== 'undefined' && _ccAutoSaveTimer){
    clearTimeout(_ccAutoSaveTimer);
    _ccAutoSaveTimer = null;
  }
  if(typeof CloudVault !== 'undefined'){
    clearTimeout(CloudVault._retryTimer);
    CloudVault._retryCount = 0;
  }

  // QUAN TRỌNG: đọc thử (peek) bản MỚI NHẤT trên Cloud và gộp vào trước khi xoá — máy này có thể
  // đang có bản CŨ HƠN Cloud (VD: người khác vừa "Xác nhận" thêm dòng ở máy/ca khác mà máy này chưa
  // kịp "Làm mới dữ liệu"). Nếu không gộp trước, "Đặt lại toàn bộ" chỉ xoá đúng những gì máy NÀY
  // đang thấy rồi ghi đè lên Cloud — vô tình xoá mất luôn cả phần người khác vừa làm mà máy này
  // chưa từng biết tới.
  if(cloudActive){
    if(btn) btn.disabled = true;
    try{
      const cloudData = await CloudVault.peek();
      if(cloudData) mergeConfirmedDataFromCloud(cloudData);
    }catch(e){ console.warn('Không gộp được dữ liệu Cloud trước khi Đặt lại toàn bộ:', e); }
    finally{ if(btn) btn.disabled = false; }
  }

  const hasAnything = Object.keys(ccKhoResults).length || Object.keys(ktInputValues).length ||
    Object.keys(scannedExtraRows).length || scannedGiSet.size || giScanLog.length ||
    Object.keys(confirmedKiemTonItems).length;
  if(!hasAnything){
    alert('Không có dữ liệu nào để đặt lại (đã kiểm tra cả bản mới nhất trên Cloud).');
    return;
  }
  const ok = confirm(
    'Đặt lại TOÀN BỘ dữ liệu của "Đề xuất kiểm hôm nay" VÀ "Đã xác nhận" (cả 3 kho)?\n\n' +
    'Sẽ xoá: danh sách Đề xuất kiểm đã tạo, mọi ô "KT =" đang nhập dở (kể cả số liệu cũ còn sót từ ' +
    'đợt trước — đã gộp thêm bản mới nhất từ Cloud để không sót phần máy/ca khác vừa làm), các dòng ' +
    'quét QR sai vị trí, lịch sử GI đã quét, VÀ TOÀN BỘ danh sách "Đã xác nhận" (các dòng đã bấm ' +
    '"Xác nhận" nhưng CHƯA bấm "Lưu" để lưu vào lịch sử sẽ bị MẤT hẳn, không khôi phục được).\n\n' +
    'Thao tác này không thể hoàn tác — và sẽ đồng bộ lên Cloud ngay, các máy/ca khác cũng sẽ thấy bảng trống.'
  );
  if(!ok) return;

  if(btn) btn.disabled = true;
  try{
    CC_KHO_LIST.forEach(k => ccClearKhoResult(k.label));
    // Xoá TRẮNG, không chỉ những dòng thuộc danh sách vừa xoá ở trên.
    ktInputValues = {};
    scannedExtraRows = {};
    confirmedKiemTonItems = {};
    scannedGiSet.forEach(g => _deletedGiKeys.add(g));
    scannedGiSet.clear();
    giScanLog = [];
    if(typeof updateQrGiClearBtn === 'function') updateQrGiClearBtn();
    saveStateToStorage();
    renderKhoSearchPage();
    renderConfirmedList();

    if(typeof CloudVault !== 'undefined' && CloudVault.url && CloudVault.token){
      await CloudVault.writeAll();
      // Sau khi PUT đã được Firebase xác nhận, coi mốc vừa ghi là hàng rào mới: mọi snapshot
      // realtime cũ hơn mốc này sẽ bị bỏ qua bởi _onRealtimeStampValue/_applyCloudSnapshot.
      CloudVault._pendingStampDirty = false;
      if(typeof clearUnsavedChanges === 'function') clearUnsavedChanges();
    }
    if(typeof showAppToast === 'function') showAppToast('✓ Đã đặt lại toàn bộ dữ liệu Đề xuất kiểm + Đã xác nhận, đã đồng bộ Cloud.');
  }catch(e){
    console.warn('Đồng bộ Cloud sau khi Đặt lại toàn bộ thất bại:', e);
    if(typeof showAppToast === 'function') showAppToast(`⚠ Đã đặt lại trên máy này nhưng CHƯA đồng bộ được lên Cloud (${e.message}). Bấm "Lưu" ở đầu trang để thử lại.`);
  }finally{
    if(btn) btn.disabled = false;
  }
});

// Dựng 1 sheet "Đề xuất kiểm" vào workbook đã có sẵn — dùng chung cho cả xuất riêng từng kho lẫn
// xuất báo cáo tổng hợp 3 kho. Trả về vài số liệu tóm tắt để điền vào sheet "Tổng quan".
function ccBuildDeXuatSheet(workbook, khoLabel, result, createSheet){
  if(createSheet === undefined) createSheet = true;
  let flatRows = result.mode === 'locator'
    ? result.list.flatMap(loc => loc.items)
    : result.list.slice();

  flatRows = flatRows.slice().sort((a,b) => {
    const locCmp = String(a.locator).localeCompare(String(b.locator), 'vi');
    if(locCmp !== 0) return locCmp;
    const itemCmp = String(a.item).localeCompare(String(b.item), 'vi');
    if(itemCmp !== 0) return itemCmp;
    return String(a.custpo || '').localeCompare(String(b.custpo || ''), 'vi');
  });

  if(createSheet){
    const modeText = result.mode === 'item' ? 'Mã hàng' : result.mode === 'locator' ? 'Locator' : 'Pallet';
    const khoCode = (CC_KHO_LIST.find(k => k.label === khoLabel) || {}).code || khoLabel.replace('Kho ', '');
    const ws = workbook.addWorksheet(`De xuat kiem ${khoCode}`.slice(0, 31));
    // Theo yêu cầu: đổi mặc định in dọc (portrait) — trước đây in ngang (landscape). Vẫn giữ
    // fitToWidth:1 để Excel tự co giãn cột vừa đúng 1 trang khổ dọc, không cần chỉnh tay.
    ws.pageSetup = {
      paperSize: 9, orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0,
      horizontalCentered: true, margins: { left:0.35, right:0.35, top:0.5, bottom:0.5, header:0.2, footer:0.2 }
    };

    const headers = ['STT', 'Locator', 'Số pallet', 'Cust PO', 'Item No.', 'OQC', 'Số lượng', 'Kết quả kiểm thực tế (điền tay)'];
    const thin = { style:'thin', color:{ argb:'FF999999' } };
    const thick = { style:'medium', color:{ argb:'FF222222' } };

    ws.mergeCells(1,1,1,headers.length);
    const titleCell = ws.getCell(1,1);
    titleCell.value = `Danh sách đề xuất kiểm hôm nay — ${khoLabel} (chế độ: ${modeText})`;
    titleCell.font = { bold:true, size:13 };

    ws.mergeCells(2,1,2,headers.length);
    const dateCell = ws.getCell(2,1);
    dateCell.value = `Ngày in: ${new Date().toLocaleDateString('vi-VN')} · Tổng số dòng: ${flatRows.length}`;
    dateCell.font = { italic:true, color:{ argb:'FF666666' } };

    const headerExcelRow = 4;
    ws.pageSetup.printTitlesRow = `${headerExcelRow}:${headerExcelRow}`;
    ws.getRow(headerExcelRow).values = headers;
    const headerRow = ws.getRow(headerExcelRow);
    headerRow.font = { bold:true };
    headerRow.height = 20;
    headerRow.eachCell(cell => {
      cell.fill = { type:'pattern', pattern:'solid', fgColor:{ argb:'FFEFEFEF' } };
      cell.alignment = { vertical:'middle', horizontal:'center', wrapText:true };
      cell.border = { top:thick, left:thin, right:thin, bottom:thick };
    });

    ws.columns = [
      { width:5 }, { width:14 }, { width:9 }, { width:14 }, { width:14 }, { width:9 }, { width:9 }, { width:22 }
    ];

    flatRows.forEach((r, i) => {
      const excelRowNum = headerExcelRow + 1 + i;
      const isLastOfGroup = (i === flatRows.length - 1) || (flatRows[i+1].locator !== r.locator);
      const isFirstOfGroup = (i === 0) || (flatRows[i-1].locator !== r.locator);
      const row = ws.getRow(excelRowNum);
      row.values = [
        i + 1,
        r.locator,
        r.palletCount || '',
        r.custpo || '',
        r.item,
        r.oqc || '',
        typeof r.qty === 'number' ? r.qty : (parseFloat(r.qty) || 0),
        ''
      ];
      row.alignment = { vertical:'middle' };
      for(let c = 1; c <= headers.length; c++){
        const cell = row.getCell(c);
        cell.border = {
          top: isFirstOfGroup ? thick : thin,
          bottom: isLastOfGroup ? thick : thin,
          left: (c === 1) ? thick : thin,
          right: (c === headers.length) ? thick : thin
        };
        if(c === 2 || c === 3 || c === 4 || c === 5 || c === 8) cell.alignment = { vertical:'middle', horizontal:'left', wrapText:true };
        else if(c === 7) cell.alignment = { vertical:'middle', horizontal:'right' };
        else cell.alignment = { vertical:'middle', horizontal:'center' };
      }
    });
  }

  return {
    rowCount: flatRows.length,
    locatorCount: new Set(flatRows.map(r => r.locator)).size,
    itemCount: new Set(flatRows.map(r => r.item)).size,
    qtySum: flatRows.reduce((s,r) => s + (typeof r.qty === 'number' ? r.qty : (parseFloat(r.qty) || 0)), 0),
    palletSum: flatRows.reduce((s,r) => s + (r.palletCount || 0), 0)
  };
}

async function ccExportKhoExcel(khoLabel, result){
  if(!LIB_EXCELJS_OK){ alert('Không xuất được Excel: thư viện ExcelJS chưa tải được (cần Internet).'); return; }
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'TN5 Dashboard';
  workbook.created = new Date();
  ccBuildDeXuatSheet(workbook, khoLabel, result);
  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer], { type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const khoCodeSafe = khoLabel.replace(/[^0-9A-Za-z]/g, '_');
  const stamp = new Date().toISOString().slice(0,10);
  a.href = url;
  a.download = `De_xuat_kiem_${khoCodeSafe}_${result.mode}_${stamp}.xlsx`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// Xuất báo cáo tổng hợp cả 3 kho vào 1 file: Sheet "Tổng quan" tóm tắt, kèm 1 sheet "Đề xuất kiểm"
// + 1 sheet "Đã xác nhận" cho MỖI kho ĐÃ "Tạo danh sách" — kho nào chưa tạo danh sách thì ẩn hẳn,
// không có sheet nào cho kho đó (kể cả không có dòng nào ở Tổng quan).
async function exportCombinedReportAllKho(){
  if(!LIB_EXCELJS_OK){ alert('Không xuất được Excel: thư viện ExcelJS chưa tải được (cần Internet).'); return; }

  const khoWithList = CC_KHO_LIST.filter(k => ccKhoResults[k.label]);
  if(!khoWithList.length){
    alert('Chưa có kho nào được "Tạo danh sách" — hãy tạo danh sách đề xuất kiểm cho ít nhất 1 kho trước khi xuất báo cáo tổng hợp.');
    return;
  }

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'TN5 Dashboard';
  workbook.created = new Date();

  // Tạo sheet Tổng quan TRƯỚC (để nó luôn nằm ở tab đầu tiên) — điền số liệu vào SAU khi đã dựng
  // xong các sheet chi tiết của từng kho, vì cần lấy số liệu tóm tắt từ đó.
  const wsOverview = workbook.addWorksheet('Tong quan');

  const summaryRows = [];
  const chartSpecs = [];
  let nextSheetPosition = 2; // sheet 1 = Tổng quan
  for(const k of khoWithList){
    const result = ccKhoResults[k.label];
    const deXuatStats = ccBuildDeXuatSheet(workbook, k.label, result, false); // false = chỉ lấy số liệu, không tạo sheet "Đề xuất kiểm" trong báo cáo tổng hợp
    const xacNhanStats = ccBuildDaXacNhanSheet(workbook, k.label); // null nếu kho này chưa xác nhận dòng nào — sheet không được tạo
    const confirmedCount = xacNhanStats ? xacNhanStats.rowCount : 0;
    const mismatchCount = xacNhanStats ? xacNhanStats.mismatchCount : 0;
    if(xacNhanStats){
      chartSpecs.push({ sheetPosition: nextSheetPosition, chartInfo: xacNhanStats.chartInfo });
      nextSheetPosition++;
    }
    summaryRows.push({
      kho: k.label.replace('Kho ', ''),
      locatorCount: deXuatStats.locatorCount,
      itemCount: deXuatStats.itemCount,
      qtySum: deXuatStats.qtySum,
      palletSum: deXuatStats.palletSum,
      rowCount: deXuatStats.rowCount,
      confirmedCount,
      mismatchCount
    });
  }

  const headers = ['Kho', 'Locator cần kiểm', 'Số mã hàng', 'SL Pcs', 'SL pallet', 'Đã kiểm', 'Số dòng lệch', 'Tỷ lệ hoàn thành', 'Tỷ lệ sai lệch'];
  const thin = { style:'thin', color:{ argb:'FF999999' } };
  const thick = { style:'medium', color:{ argb:'FF222222' } };

  wsOverview.pageSetup = {
    paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0,
    horizontalCentered: true, margins: { left:0.35, right:0.35, top:0.5, bottom:0.5, header:0.2, footer:0.2 }
  };

  wsOverview.mergeCells(1,1,1,headers.length);
  wsOverview.getCell(1,1).value = 'Báo cáo tổng hợp Kiểm tồn kho — 3 Kho';
  wsOverview.getCell(1,1).font = { bold:true, size:14 };

  wsOverview.mergeCells(2,1,2,headers.length);
  wsOverview.getCell(2,1).value = `Ngày in: ${new Date().toLocaleDateString('vi-VN')}`;
  wsOverview.getCell(2,1).font = { italic:true, color:{ argb:'FF666666' } };

  const headerRowNum = 4;
  wsOverview.getRow(headerRowNum).values = headers;
  const hRow = wsOverview.getRow(headerRowNum);
  hRow.font = { bold:true };
  hRow.height = 20;
  hRow.eachCell(cell => {
    cell.fill = { type:'pattern', pattern:'solid', fgColor:{ argb:'FFEFEFEF' } };
    cell.alignment = { vertical:'middle', horizontal:'center', wrapText:true };
    cell.border = { top:thick, left:thin, right:thin, bottom:thick };
  });
  wsOverview.columns = [{ width:10 }, { width:15 }, { width:12 }, { width:11 }, { width:11 }, { width:11 }, { width:13 }, { width:15 }, { width:14 }];

  let totalLoc = 0, totalItem = 0, totalQty = 0, totalPallet = 0, totalConfirmed = 0, totalMismatch = 0, totalRowCount = 0;
  summaryRows.forEach((s, i) => {
    const rn = headerRowNum + 1 + i;
    const row = wsOverview.getRow(rn);
    const completeRatio = s.rowCount ? (s.confirmedCount / s.rowCount * 100).toFixed(1) + '%' : '0%';
    const mismatchRatio = s.confirmedCount ? (s.mismatchCount / s.confirmedCount * 100).toFixed(1) + '%' : '0%';
    row.values = [s.kho, s.locatorCount, s.itemCount, s.qtySum, s.palletSum, s.confirmedCount, s.mismatchCount, completeRatio, mismatchRatio];
    row.alignment = { vertical:'middle' };
    for(let c = 1; c <= headers.length; c++){
      const cell = row.getCell(c);
      cell.border = { top:thin, bottom:thin, left: c===1?thick:thin, right: c===headers.length?thick:thin };
      cell.alignment = { vertical:'middle', horizontal: c===1 ? 'center' : 'right' };
    }
    totalLoc += s.locatorCount; totalItem += s.itemCount; totalQty += s.qtySum; totalPallet += s.palletSum;
    totalConfirmed += s.confirmedCount; totalMismatch += s.mismatchCount; totalRowCount += s.rowCount;
  });
  const totalRn = headerRowNum + 1 + summaryRows.length;
  const totalRow = wsOverview.getRow(totalRn);
  const totalCompleteRatio = totalRowCount ? (totalConfirmed / totalRowCount * 100).toFixed(1) + '%' : '0%';
  const totalMismatchRatio = totalConfirmed ? (totalMismatch / totalConfirmed * 100).toFixed(1) + '%' : '0%';
  totalRow.values = ['Tổng', totalLoc, totalItem, totalQty, totalPallet, totalConfirmed, totalMismatch, totalCompleteRatio, totalMismatchRatio];
  totalRow.font = { bold:true };
  for(let c = 1; c <= headers.length; c++){
    const cell = totalRow.getCell(c);
    cell.fill = { type:'pattern', pattern:'solid', fgColor:{ argb:'FFF6F6F6' } };
    cell.border = { top:thick, bottom:thick, left: c===1?thick:thin, right: c===headers.length?thick:thin };
    cell.alignment = { vertical:'middle', horizontal: c===1 ? 'center' : 'right' };
  }

  const buffer = await workbook.xlsx.writeBuffer();
  const processed = await injectRealPieCharts(buffer, chartSpecs);
  const blob = processed instanceof Blob ? processed : new Blob([processed], { type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const dateStr = new Date().toISOString().slice(0,10);
  a.href = url;
  a.download = `Bao_cao_tong_hop_${dateStr}.xlsx`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/* ============================================================================
   MODAL "TỰ CHỌN" — chọn tay hoặc random Mã hàng / Locator cần kiểm, rồi bấm
   "Tạo bảng" để hiển thị kết quả vào đúng khối kết quả của kho đó (dùng chung
   hạ tầng renderer/xuất Excel/nhập ô tìm kiếm đã có sẵn cho Đề xuất kiểm hôm nay).
============================================================================ */
let ccCustomState = {
  khoLabel: null,
  tab: 'item',
  selected: { item: new Set(), locator: new Set() }
};

// Danh sách các Item No. riêng biệt trong 1 kho (đã loại PICK/Loading/PROD/SPP), kèm số locator + SL tồn
function ccGetDistinctItemsForKho(khoLabel){
  const invRows = ccBuildInventoryRows(true);
  const byItem = new Map();
  invRows.forEach(row => {
    if(row.kho !== khoLabel) return;
    if(!byItem.has(row.item)) byItem.set(row.item, { item: row.item, locators: new Set(), qty: 0 });
    const e = byItem.get(row.item);
    e.locators.add(row.locator);
    e.qty += row.qty;
  });
  return Array.from(byItem.values())
    .map(e => ({ item: e.item, locatorCount: e.locators.size, qty: e.qty }))
    .sort((a,b) => a.item.localeCompare(b.item));
}

// Danh sách các Locator riêng biệt trong 1 kho, kèm số mã + số pallet
function ccGetDistinctLocatorsForKho(khoLabel){
  const invRows = ccBuildInventoryRows(true);
  const byLoc = new Map();
  invRows.forEach(row => {
    if(row.kho !== khoLabel) return;
    if(!byLoc.has(row.locator)) byLoc.set(row.locator, { locator: row.locator, items: new Set(), palletCount: 0 });
    const e = byLoc.get(row.locator);
    e.items.add(row.item);
    e.palletCount += row.palletCount;
  });
  return Array.from(byLoc.values())
    .map(e => ({ locator: e.locator, itemCount: e.items.size, palletCount: e.palletCount }))
    .sort((a,b) => a.locator.localeCompare(b.locator));
}

function ccCustomGetSourceList(){
  if(!ccCustomState.khoLabel) return [];
  return ccCustomState.tab === 'item'
    ? ccGetDistinctItemsForKho(ccCustomState.khoLabel)
    : ccGetDistinctLocatorsForKho(ccCustomState.khoLabel);
}

function ccCustomOpen(khoLabel){
  ccCustomState.khoLabel = khoLabel;
  ccCustomState.tab = 'locator';
  ccCustomState.selected.item.clear();
  ccCustomState.selected.locator.clear();
  const titleEl = document.getElementById('cc-custom-title');
  const descEl = document.getElementById('cc-custom-desc');
  if(titleEl) titleEl.textContent = `Tự chọn danh sách kiểm — ${khoLabel}`;
  if(descEl) descEl.textContent = 'Chọn thủ công hoặc bấm "Chọn random" theo số lượng mong muốn, rồi bấm "Tạo bảng"';
  document.querySelectorAll('#cc-custom-tabs .cc-mode-tab').forEach(b => b.classList.toggle('active', b.dataset.cctab === 'locator'));
  const filterEl = document.getElementById('cc-custom-filter');
  if(filterEl) filterEl.value = '';
  ccCustomUpdateSliderMax();
  ccCustomRenderList();
  ccCustomUpdateFooter();
  const overlay = document.getElementById('cc-custom-overlay');
  if(overlay) overlay.classList.add('show');
}

function ccCustomClose(){
  const overlay = document.getElementById('cc-custom-overlay');
  if(overlay) overlay.classList.remove('show');
}

function ccCustomUpdateSliderMax(){
  const total = ccCustomGetSourceList().length;
  const slider = document.getElementById('cc-custom-random-slider');
  const label = document.getElementById('cc-custom-random-label');
  if(!slider) return;
  slider.max = String(Math.max(1, total));
  if(Number(slider.value) > total) slider.value = String(Math.max(1, total));
  const unit = ccCustomState.tab === 'item' ? 'mã' : 'vị trí';
  if(label) label.textContent = `${slider.value} ${unit} / ${fmt(total)}`;
}

function ccCustomRenderList(){
  const listEl = document.getElementById('cc-custom-list');
  if(!listEl) return;
  const filterEl = document.getElementById('cc-custom-filter');
  const filterText = filterEl ? filterEl.value.trim().toLowerCase() : '';
  const source = ccCustomGetSourceList();
  const selectedSet = ccCustomState.selected[ccCustomState.tab];

  const filtered = filterText
    ? source.filter(e => (ccCustomState.tab === 'item' ? e.item : e.locator).toLowerCase().includes(filterText))
    : source;

  if(!filtered.length){
    listEl.innerHTML = `<div class="cc-custom-empty">Không có ${ccCustomState.tab === 'item' ? 'mã hàng' : 'vị trí'} nào khớp.</div>`;
    return;
  }

  listEl.innerHTML = filtered.map(e => {
    const key = ccCustomState.tab === 'item' ? e.item : e.locator;
    const checked = selectedSet.has(key) ? 'checked' : '';
    const sub = ccCustomState.tab === 'item'
      ? `${e.locatorCount} vị trí · ${fmt(e.qty)} Pcs`
      : `${e.itemCount} mã · ${fmt(e.palletCount)} pallet`;
    return `<label class="cc-custom-item" data-key="${escAttr(key)}">
        <input type="checkbox" ${checked}>
        <span class="cc-ci-main">${escHtml(key)}</span>
        <span class="cc-ci-sub">${sub}</span>
      </label>`;
  }).join('');
}

function ccCustomUpdateFooter(){
  const countEl = document.getElementById('cc-custom-selected-count');
  if(!countEl) return;
  const selectedSet = ccCustomState.selected[ccCustomState.tab];
  const n = selectedSet.size;
  const unit = ccCustomState.tab === 'item' ? 'mã' : 'vị trí';
  // Cộng thêm tổng pallet (chế độ Locator) / tổng SL tồn Pcs (chế độ Mã hàng) của ĐÚNG các mục đã
  // chọn — để biết ngay khối lượng thực tế sẽ đưa vào bảng kiểm, không chỉ đếm số mục đã tick.
  let extra = '';
  if(n > 0){
    const keyField = ccCustomState.tab === 'item' ? 'item' : 'locator';
    const valueField = ccCustomState.tab === 'item' ? 'qty' : 'palletCount';
    const extraUnit = ccCustomState.tab === 'item' ? 'Pcs' : 'pallet';
    let total = 0;
    ccCustomGetSourceList().forEach(e => {
      if(selectedSet.has(e[keyField])) total += e[valueField];
    });
    extra = `, ${fmt(total)} ${extraUnit}`;
  }
  countEl.textContent = `Đã chọn: ${fmt(n)} ${unit}${extra}`;
}

// Mở modal khi bấm "Tự chọn…" trên 1 thẻ kho
document.addEventListener('click', function(e){
  const btn = e.target.closest('.cc-custom-btn');
  if(!btn) return;
  ccCustomOpen(btn.dataset.kho);
});

// Đóng modal
document.addEventListener('click', function(e){
  if(e.target.id === 'cc-custom-overlay' || e.target.closest('#cc-custom-close')) ccCustomClose();
});
document.addEventListener('keydown', (e) => { if(e.key === 'Escape') ccCustomClose(); });

// Chuyển tab Mã hàng / Locator trong modal Tự chọn
document.addEventListener('click', function(e){
  const tab = e.target.closest('#cc-custom-tabs .cc-mode-tab');
  if(!tab) return;
  ccCustomState.tab = tab.dataset.cctab;
  document.querySelectorAll('#cc-custom-tabs .cc-mode-tab').forEach(b => b.classList.toggle('active', b === tab));
  const filterEl = document.getElementById('cc-custom-filter');
  if(filterEl) filterEl.value = '';
  ccCustomUpdateSliderMax();
  ccCustomRenderList();
  ccCustomUpdateFooter();
});

// Gõ lọc danh sách trong modal
document.addEventListener('input', function(e){
  if(e.target.id === 'cc-custom-filter') ccCustomRenderList();
});

// Kéo thanh trượt số lượng random -> cập nhật nhãn
document.addEventListener('input', function(e){
  if(e.target.id !== 'cc-custom-random-slider') return;
  const total = ccCustomGetSourceList().length;
  const unit = ccCustomState.tab === 'item' ? 'mã' : 'vị trí';
  const label = document.getElementById('cc-custom-random-label');
  if(label) label.textContent = `${e.target.value} ${unit} / ${fmt(total)}`;
});

// Tick / bỏ tick 1 dòng trong danh sách
document.addEventListener('change', function(e){
  const row = e.target.closest('.cc-custom-item');
  if(!row) return;
  const key = row.dataset.key;
  const selectedSet = ccCustomState.selected[ccCustomState.tab];
  if(e.target.checked) selectedSet.add(key); else selectedSet.delete(key);
  ccCustomUpdateFooter();
});

// Nút "Chọn random" -> chọn ngẫu nhiên đúng số lượng theo thanh trượt (thay thế lựa chọn hiện tại)
document.addEventListener('click', function(e){
  if(!e.target.closest('#cc-custom-random-btn')) return;
  const filterEl = document.getElementById('cc-custom-filter');
  const filterText = filterEl ? filterEl.value.trim().toLowerCase() : '';
  const source = ccCustomGetSourceList();
  const pool = filterText
    ? source.filter(x => (ccCustomState.tab === 'item' ? x.item : x.locator).toLowerCase().includes(filterText))
    : source;
  const slider = document.getElementById('cc-custom-random-slider');
  const n = Math.min(pool.length, Math.max(1, Number(slider ? slider.value : 10)));
  const shuffled = [...pool];
  for(let i = shuffled.length - 1; i > 0; i--){
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const picked = shuffled.slice(0, n).map(x => ccCustomState.tab === 'item' ? x.item : x.locator);
  ccCustomState.selected[ccCustomState.tab] = new Set(picked);
  ccCustomRenderList();
  ccCustomUpdateFooter();
});

// Nút "Chọn tất cả (đã lọc)"
document.addEventListener('click', function(e){
  if(!e.target.closest('#cc-custom-select-all-btn')) return;
  const filterEl = document.getElementById('cc-custom-filter');
  const filterText = filterEl ? filterEl.value.trim().toLowerCase() : '';
  const source = ccCustomGetSourceList();
  const pool = filterText
    ? source.filter(x => (ccCustomState.tab === 'item' ? x.item : x.locator).toLowerCase().includes(filterText))
    : source;
  const selectedSet = ccCustomState.selected[ccCustomState.tab];
  pool.forEach(x => selectedSet.add(ccCustomState.tab === 'item' ? x.item : x.locator));
  ccCustomRenderList();
  ccCustomUpdateFooter();
});

// Nút "Bỏ chọn tất cả"
document.addEventListener('click', function(e){
  if(!e.target.closest('#cc-custom-clear-btn')) return;
  ccCustomState.selected[ccCustomState.tab].clear();
  ccCustomRenderList();
  ccCustomUpdateFooter();
});

// Nút "Tạo bảng" -> tính điểm cho các mã/locator đã chọn, hiển thị vào đúng khối kết quả của kho đó
document.addEventListener('click', function(e){
  if(!e.target.closest('#cc-custom-build-btn')) return;
  const khoLabel = ccCustomState.khoLabel;
  const khoObj = CC_KHO_LIST.find(k => k.label === khoLabel);
  if(!khoObj) return;
  const tab = ccCustomState.tab;
  const selectedSet = ccCustomState.selected[tab];
  if(!selectedSet.size){ alert('Chưa chọn mã hàng/vị trí nào.'); return; }

  let list;
  if(tab === 'locator'){
    list = ccComputeLocatorScoresForKho(khoLabel, true).filter(loc => selectedSet.has(loc.locator));
  } else {
    list = ccComputeScoresForKho(khoLabel, true).filter(row => selectedSet.has(row.item));
  }

  // Đồng bộ lại tab chế độ + kết quả hiển thị trên thẻ kho tương ứng
  ccKhoMode[khoLabel] = tab;
  ccKhoResults[khoLabel] = { mode: tab, list };
  const card = document.querySelector(`.cc-kho-card[data-kho="${CSS.escape(khoLabel)}"]`);
  if(card){
    card.dataset.mode = tab;
    card.querySelectorAll('.cc-mode-tab').forEach(b => b.classList.toggle('active', b.dataset.mode === tab));
  }
  ccUpdateSliderLabel(khoObj.code);
  if(tab === 'locator') ccRenderLocatorCards(khoObj.code, khoLabel, list);
  else ccRenderKhoResult(khoObj.code, khoLabel, tab, list);
  // 2 dòng này trước đây BỊ THIẾU ở nhánh "Tạo bảng" (tự chọn) — nút "Tạo danh sách" (random/trực
  // tiếp) đã có sẵn cả 2, nên tạo qua "Tự chọn" trước đây không khoá thẻ kho lại (bấm nhầm dễ tạo đè
  // mất danh sách vừa chọn) và không tự đẩy lên Cloud (phải tự bấm "Lưu" mới lên, dễ quên).
  ccSetCardLocked(khoLabel, true);
  saveStateToStorage();
  scheduleCcAutoSaveToCloud();

  ccCustomClose();
  const resultEl = document.getElementById('cc-result-' + khoObj.code);
  if(resultEl) resultEl.scrollIntoView({ behavior:'smooth', block:'nearest' });
});

// Sự kiện mở/đóng phần "Nhập số liệu" trên thẻ mobile (chế độ card cho bảng Kiểm tồn kho)
document.addEventListener('click', function(e) {
  const toggle = e.target.closest('.kt-calc-toggle');
  if (!toggle) return;
  const cell = toggle.closest('.kt-calc-cell');
  if (!cell) return;
  cell.classList.toggle('expanded');
});

// Bấm vào 1 trong 6 ô nhập số của bảng Kiểm tồn kho sẽ tự xoá trắng để nhập nhanh,
// không cần xoá số mặc định (0/1) bằng tay trước
document.addEventListener('focusin', function(e) {
  if (!e.target.classList || !e.target.classList.contains('kt-input')) return;
  e.target.value = '';
});
// Nếu rời khỏi ô mà chưa nhập gì, khôi phục lại giá trị mặc định (0 hoặc 1) để không làm sai phép tính
document.addEventListener('focusout', function(e) {
  if (!e.target.classList || !e.target.classList.contains('kt-input')) return;
  if (e.target.value.trim() === '') {
    e.target.value = e.target.dataset.default || '0';
    e.target.dispatchEvent(new Event('input', { bubbles: true }));
  }
});

// Sự kiện tự động tính tổng cho cột Kiểm thực tế
document.addEventListener('input', function(e) {
  if (e.target.classList.contains('kt-input')) {
    const td = e.target.closest('td');
    if (!td) return;
    const inputs = td.querySelectorAll('.kt-input');
    const vals = Array.from(inputs).map(inp => parseFloat(inp.value) || 0);
    let total = 0;
    if (vals.length >= 6) {
      total = (vals[0] * vals[1]) + (vals[2] * vals[3]) + (vals[4] * vals[5]);
    }
    const tr = td.closest('tr');
    const resultSpan = td.querySelector('.kt-result');
    if (resultSpan) {
      resultSpan.textContent = Math.round(total).toLocaleString('en-US');
      // Tô lại màu so sánh với SL tồn ngay khi số vừa đổi — không cần đợi bấm Xác nhận mới biết đủ/thiếu/dư.
      const qtyCell = tr ? tr.querySelector('td[data-label="SL tồn"]') : null;
      const qty = qtyCell ? parseFloat(qtyCell.textContent.replace(/,/g, '')) || 0 : 0;
      resultSpan.style.color = ktResultColor(total, qty);
    }
    // Lưu lại giá trị vừa nhập theo rowKey để không bị mất khi bảng render lại
    // (VD: sau khi bấm "Xác nhận" ở 1 dòng khác trong cùng bảng).
    const rowKey = getRowKeyFromTr(tr);
    if (rowKey){ ktInputValues[rowKey] = vals; saveKtInputValuesDebounced(); }
  }
});

// Xác nhận 1 dòng (dùng chung cho: bấm nút "Xác nhận" từng dòng, bấm "✓✓ Cả vị trí", và nhấn Enter
// trong ô nhập số). Trả về true nếu vừa xác nhận thành công, false nếu dòng đã khoá từ trước (bỏ qua).
function confirmSingleRow(tr){
  if(!tr) return false;
  const td = tr.querySelector('td.kt-calc-cell');
  if(!td) return false;
  const btn = td.querySelector('.kt-confirm-btn');
  if(!btn || btn.dataset.locked === 'true') return false;

  const byLabel = (label) => {
    const cell = tr.querySelector(`td[data-label="${label}"]`);
    if(!cell) return '';
    const sel = cell.querySelector('select');
    if(sel) return sel.value;
    const textSpan = cell.querySelector('.loc-text');
    if(textSpan) return textSpan.textContent.trim();
    return cell.textContent.trim();
  };
  const rowKey = getRowKeyFromTr(tr);
  const item = byLabel('Item No.');
  const custpo = byLabel('Cust PO');
  const locator = byLabel('Locator');
  const oqcText = byLabel('OQC');
  const qtyText = byLabel('SL tồn');
  const qty = parseFloat(qtyText.replace(/,/g, '')) || 0;
  let oqc = 'Khac';
  if(oqcText.toUpperCase().includes('PASS')) oqc = 'PASS';
  else if(oqcText.toUpperCase().includes('NG')) oqc = 'NG';

  // Dòng "sai vị trí"/"sai OQC" (tự thêm khi quét QR lệch so với hệ thống) — giữ lại thông tin WMS
  // ghi nhận để hiện tiếp ở bảng "Đã xác nhận" sau khi bấm Xác nhận, không bị mất đi.
  const isWrongLocation = tr.dataset.wrongLocation === '1';
  const wmsLocator = tr.dataset.wmsLocator || '';
  const isWrongOqc = tr.dataset.wrongOqc === '1';
  const wmsOqc = tr.dataset.wmsOqc || '';

  const inputs = td.querySelectorAll('.kt-input');
  const inputValues = Array.from(inputs).map(inp => parseFloat(inp.value) || 0);
  const total = (inputValues[0] * inputValues[1]) + (inputValues[2] * inputValues[3]) + (inputValues[4] * inputValues[5]);

  const rowData = { kho: byLabel('Kho'), item, custpo, locator, oqc, qty, isWrongLocation, wmsLocator, isWrongOqc, wmsOqc };
  confirmedKiemTonItems[rowKey] = { data: rowData, inputs: inputValues, result: Math.round(total) };
  delete ktInputValues[rowKey]; // đã chuyển hẳn qua confirmedKiemTonItems — xoá bản nháp cũ, tránh
  // lần sau nếu đề xuất lại đúng dòng này (trùng item/locator/PO/SL) sẽ tự điền sẵn số liệu cũ.

  // Ghi nhận "lần kiểm gần nhất" cho dòng này — phục vụ tính Đề xuất kiểm hôm nay
  if(item && locator) lastCheckedMap[item + '||' + locator] = new Date().toISOString();

  inputs.forEach(inp => inp.disabled = true);
  btn.textContent = 'Mở';
  btn.style.borderColor = 'var(--red)';
  btn.style.backgroundColor = 'var(--red)';
  btn.dataset.locked = 'true';
  return true;
}

// Sự kiện Xác nhận / Mở khóa dòng (cập nhật logic ẩn/hiện)
document.addEventListener('click', function(e) {
  const btn = e.target.closest('.kt-confirm-btn');
  if (!btn) return;
  const td = btn.closest('td');
  if (!td) return;
  const tr = td.closest('tr');
  if (!tr) return;
  const rowKey = getRowKeyFromTr(tr);
  const isLocked = btn.dataset.locked === 'true';

  if (!isLocked) {
    confirmSingleRow(tr);
    saveStateToStorage();
    renderKhoSearchPage(); // Sẽ tự động ẩn dòng này và hiển thị ở bảng confirm
    // "Xác nhận" là hành động DÙNG NHIỀU NHẤT trong cả app — nếu không tự đẩy Cloud, kết quả kiểm
    // vừa xác nhận có thể mất/hiện lại sai nếu người dùng tải lại trang trước khi kịp bấm "Lưu".
    scheduleAutoSaveToCloud('confirm', [STORAGE_KEY_CONFIRMED, STORAGE_KEY_KT_INPUTS, STORAGE_KEY_LASTCHECK], 'Kết quả vừa xác nhận');
  } else {
    const inputs = td.querySelectorAll('.kt-input');
    // Xóa khỏi biến confirm, nhưng giữ lại giá trị đã nhập để dòng hiện lại ở bảng chính
    // vẫn còn đúng số liệu vừa xác nhận (không bị reset về 0).
    if(confirmedKiemTonItems[rowKey]) ktInputValues[rowKey] = confirmedKiemTonItems[rowKey].inputs;
    delete confirmedKiemTonItems[rowKey];
    
    // Mở khóa dòng
    inputs.forEach(inp => inp.disabled = false);
    btn.textContent = 'Xác nhận';
    btn.style.borderColor = 'var(--teal)';
    btn.style.backgroundColor = 'var(--teal)';
    btn.dataset.locked = 'false';
    
    saveStateToStorage();
    renderKhoSearchPage(); // Sẽ tự động hiện lại dòng này ở bảng chính
    scheduleAutoSaveToCloud('confirm', [STORAGE_KEY_CONFIRMED, STORAGE_KEY_KT_INPUTS, STORAGE_KEY_LASTCHECK], 'Huỷ xác nhận');
  }
});

// Sự kiện Xoá HẲN 1 dòng khỏi "Đề xuất kiểm hôm nay" (nút 🗑 cạnh "Xác nhận") — khác với Xác nhận,
// đây là xoá thẳng không giữ lại gì, dùng khi 1 dòng bị tạo sai (VD: quét nhầm sang locator khác mà
// quên bấm "Đổi vị trí" nên hệ thống tự tạo 1 dòng mới không cần thiết).
document.addEventListener('click', function(e){
  const btn = e.target.closest('.kt-delete-btn');
  if(!btn) return;
  const tr = btn.closest('tr');
  if(!tr) return;
  const khoLabel = tr.dataset.kho || '';
  const rowKey = getRowKeyFromTr(tr);
  const itemText = (tr.querySelector('td[data-label="Item No."]') || {}).textContent?.trim() || '';
  const locText = (tr.querySelector('td[data-label="Locator"]') || {}).textContent?.trim() || '';
  if(!confirm(`Xoá hẳn dòng "${itemText}" (${locText}) khỏi danh sách đề xuất kiểm?\n\nCác GI No. đã quét gắn với dòng này (nếu có) sẽ được xoá khỏi lịch sử quét, cho phép quét lại vào đúng vị trí thực tế nếu cần.`)) return;
  const removedGiCount = ccDeleteRow(khoLabel, rowKey);
  if(removedGiCount === -1) return;
  saveStateToStorage();
  renderKhoSearchPage();
  scheduleAutoSaveToCloud('confirm', [STORAGE_KEY_CCRESULTS, STORAGE_KEY_KT_INPUTS, STORAGE_KEY_SCANNED_GI, STORAGE_KEY_GI_LOG, STORAGE_KEY_LASTCHECK, STORAGE_KEY_SCANNED_EXTRA], 'Xoá dòng đề xuất kiểm');
  if(typeof showAppToast === 'function') showAppToast(removedGiCount > 0 ? `✓ Đã xoá dòng (kèm ${removedGiCount} GI đã quét).` : '✓ Đã xoá dòng.');
});

// Bấm "✓✓ Cả vị trí" — xác nhận TẤT CẢ các dòng đang hiển thị cùng vị trí (locator) đó trong 1 lần,
// dùng đúng số liệu đang nhập hiện tại của từng dòng (dòng nào chưa nhập gì thì tính bằng 0).
document.addEventListener('click', function(e){
  const btn = e.target.closest('.kt-confirm-locator-btn');
  if(!btn) return;
  const headerTr = btn.closest('tr');
  if(!headerTr) return;
  const rowsToConfirm = [];
  let sib = headerTr.nextElementSibling;
  while(sib && !sib.classList.contains('kt-loc-header-row')){
    rowsToConfirm.push(sib);
    sib = sib.nextElementSibling;
  }
  if(!rowsToConfirm.length) return;
  if(rowsToConfirm.length > 1 && !confirm(`Xác nhận tất cả ${rowsToConfirm.length} dòng đang hiện ở vị trí này? Dòng nào chưa nhập số liệu sẽ tính bằng 0.`)) return;
  let count = 0;
  rowsToConfirm.forEach((tr) => { if(confirmSingleRow(tr)) count++; });
  saveStateToStorage();
  renderKhoSearchPage();
  scheduleAutoSaveToCloud('confirm', [STORAGE_KEY_CONFIRMED, STORAGE_KEY_KT_INPUTS, STORAGE_KEY_LASTCHECK], 'Kết quả vừa xác nhận');
  if(typeof showAppToast === 'function') showAppToast(`✓ Đã xác nhận ${count} dòng ở vị trí này.`);
});

// Nhấn Enter khi đang gõ trong 1 trong 6 ô nhập số -> xác nhận luôn dòng đang nhập (tương đương bấm
// nút "Xác nhận" của đúng dòng đó), không cần với tay bấm nút.
document.addEventListener('keydown', function(e){
  if(e.key !== 'Enter') return;
  if(!e.target.classList || !e.target.classList.contains('kt-input')) return;
  e.preventDefault();
  const tr = e.target.closest('tr');
  if(!tr) return;
  if(confirmSingleRow(tr)){
    saveStateToStorage();
    renderKhoSearchPage();
    scheduleAutoSaveToCloud('confirm', [STORAGE_KEY_CONFIRMED, STORAGE_KEY_KT_INPUTS, STORAGE_KEY_LASTCHECK], 'Kết quả vừa xác nhận');
  }
});

// Hàm xuất Excel cũ của bảng đã xác nhận — đã thay bằng exportConfirmedKhoExcel() (dùng chung form
// với "Đề xuất kiểm hôm nay", tách theo từng kho). Giữ comment lại để biết lý do gỡ bỏ.

// Gán sự kiện cho nút Đặt lại của bảng Đã xác nhận (chỉ xoá danh sách đã xác nhận,
// không đụng tới dữ liệu tồn kho hay Plan đã tải)
document.getElementById('btn-reset-confirmed').addEventListener('click', async () => {
  const keys = Object.keys(confirmedKiemTonItems);
  if(!keys.length){
    alert('Danh sách đã xác nhận đang trống, không có gì để đặt lại.');
    return;
  }
  const ok = confirm(`Xoá toàn bộ ${keys.length} dòng đã xác nhận và mở khoá lại ở bảng Kiểm tồn kho?\n\nThao tác này không thể hoàn tác.`);
  if(!ok) return;

  // QUAN TRỌNG: huỷ các lượt tự lưu (autosave) còn đang chờ TRƯỚC khi xoá — cùng lý do như nút "Lưu"/
  // "Đặt lại toàn bộ": nếu không huỷ, 1 timer tự lưu cũ (từ thao tác "Xác nhận" ngay trước đó) có thể
  // chạy SAU khi đã xoá trắng ở đây, gửi lại đúng bộ khoá vừa xoá lên Cloud và làm danh sách "sống lại".
  ['cc','confirm','qrscan'].forEach(k => {
    if(typeof _autoSaveTimers !== 'undefined' && _autoSaveTimers[k]){
      clearTimeout(_autoSaveTimers[k]);
      _autoSaveTimers[k] = null;
    }
    if(typeof _pendingAutoSaveKeys !== 'undefined') _pendingAutoSaveKeys.delete(k);
  });
  if(typeof _ccAutoSaveTimer !== 'undefined' && _ccAutoSaveTimer){
    clearTimeout(_ccAutoSaveTimer);
    _ccAutoSaveTimer = null;
  }
  if(typeof CloudVault !== 'undefined'){
    clearTimeout(CloudVault._retryTimer);
    CloudVault._retryCount = 0;
  }

  // Trả lại đúng số liệu KT đã nhập trước đó cho từng dòng (giống hệt restoreConfirmedItem) — không
  // để trống, vì các dòng này vẫn còn nguyên trong danh sách "Đề xuất kiểm hôm nay", chỉ là mở khoá
  // lại để nhập/sửa tiếp thôi.
  keys.forEach(k => { ktInputValues[k] = confirmedKiemTonItems[k].inputs; });
  confirmedKiemTonItems = {};
  saveStateToStorage();
  renderConfirmedList();
  renderKhoSearchPage(); // Hiện lại toàn bộ các dòng vừa mở khoá ở bảng Kiểm tồn kho

  // Đẩy NGAY lên Cloud (nếu đã kết nối) — cùng lý do như nút "Lưu": nếu không đẩy ngay, lần tải lại
  // dữ liệu Cloud tiếp theo sẽ lấy về bản CŨ (chưa đặt lại) và làm danh sách hiện lại như cũ.
  if(typeof CloudVault !== 'undefined' && CloudVault.url && CloudVault.token){
    try{
      await CloudVault.writeAll();
      if(typeof clearUnsavedChanges === 'function') clearUnsavedChanges();
    }catch(e){
      console.warn('Đồng bộ Cloud sau khi Đặt lại thất bại:', e);
      if(typeof showAppToast === 'function') showAppToast(`⚠ Đã đặt lại trên máy này nhưng CHƯA đồng bộ được lên Cloud (${e.message}). Bấm "Lưu" ở đầu trang để thử lại.`);
    }
  }
});

const pageOverviewEl = document.getElementById('page-overview');
const pagePickingEl = document.getElementById('page-picking');
const pageSearchEl = document.getElementById('page-search');
const pageKiemTonEl = document.getElementById('page-kiemton');
const pageSodo3bEl = document.getElementById('page-sodo3b');
const pageTransactionEl = document.getElementById('page-transaction');
const pageCompareEl = document.getElementById('page-compare');
const pageKioskEl = document.getElementById('page-kiosk');
document.querySelectorAll('.sidebar-nav-btn[data-page]').forEach(btn => {
  btn.addEventListener('click', () => {
    const page = btn.dataset.page;
    document.querySelectorAll('.sidebar-nav-btn[data-page]').forEach(b => b.classList.toggle('active', b === btn));
    if(pageOverviewEl) pageOverviewEl.style.display = page === 'overview' ? '' : 'none';
    if(pagePickingEl) pagePickingEl.style.display = page === 'picking' ? '' : 'none';
    if(pageSearchEl) pageSearchEl.style.display = page === 'search' ? '' : 'none';
    if(pageKiemTonEl) pageKiemTonEl.style.display = page === 'kiemton' ? '' : 'none';
    if(pageSodo3bEl) pageSodo3bEl.style.display = page === 'sodo3b' ? '' : 'none';
    if(pageTransactionEl) pageTransactionEl.style.display = page === 'transaction' ? '' : 'none';
    if(pageCompareEl) pageCompareEl.style.display = page === 'compare' ? '' : 'none';
    if(pageKioskEl) pageKioskEl.style.display = page === 'kiosk' ? '' : 'none';
    if(page === 'search'){
      renderKhoSearchPage();
      if(searchCtrlMain) setTimeout(() => searchCtrlMain.focus(), 50);
    }
    if(page === 'kiemton'){
      renderKhoSearchPage();
      ccInitKhoTotalsAndLabels();
      if(searchCtrlKiemTon) setTimeout(() => searchCtrlKiemTon.focus(), 50);
    }
    if(page === 'sodo3b'){
      renderSodo3B();
    }
    if(page === 'kiosk'){
      if(typeof renderKioskPage === 'function') renderKioskPage();
    }
    updateSearchFabVisibility();
  });
});
applyAppLockUI();

/* ============ Thu gọn / mở rộng panel (Bảng tổng hợp, Dữ liệu gốc theo dòng) ============ */
function ccSetCollapsePanelOpen(panelEl, open){
  if(!panelEl) return;
  panelEl.classList.toggle('open', open);
  const head = panelEl.querySelector('[data-collapse-toggle]');
  if(head) head.setAttribute('aria-expanded', open ? 'true' : 'false');
}
document.addEventListener('click', (e) => {
  const head = e.target.closest('[data-collapse-toggle]');
  if(!head) return;
  const panel = head.closest('.cc-collapse-panel');
  if(!panel) return;
  ccSetCollapsePanelOpen(panel, !panel.classList.contains('open'));
});

/* ============ Nút nổi di chuyển nhanh giữa 2 bảng ở tab "Tìm mã hàng" ============ */
function updateSearchFabVisibility(){
  const fab = document.getElementById('search-fab-jump');
  if(!fab) return;
  const active = pageSearchEl && pageSearchEl.style.display !== 'none';
  fab.style.display = active ? 'flex' : 'none';
  if(active) updateSearchFabLabel();
}
function updateSearchFabLabel(){
  const fab = document.getElementById('search-fab-jump');
  const labelEl = document.getElementById('search-fab-label');
  const khoPanel = document.getElementById('kho-summary-panel');
  const rawPanel = document.getElementById('raw-detail-panel');
  if(!fab || !khoPanel || !rawPanel) return;
  const rawRect = rawPanel.getBoundingClientRect();
  const viewportMid = window.innerHeight / 2;
  const showingRaw = rawRect.top < viewportMid;
  fab.dataset.target = showingRaw ? 'kho' : 'raw';
  fab.innerHTML = showingRaw
    ? '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><path d="m5 12 7-7 7 7"/></svg><span id="search-fab-label">Bảng tổng hợp</span>'
    : '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"/><path d="m19 12-7 7-7-7"/></svg><span id="search-fab-label">Bảng chi tiết</span>';
}
/* ============ Ghim (sticky) khối MULTI + tab kho + ô tìm kiếm ở tab "Tìm mã hàng" —
   để khi cuộn xuống bảng "Chi tiết từng dòng" vẫn tìm/lọc được, không cần cuộn lên lại. ============ */
(function initSearchStickyControls(){
  const stickyEl = document.getElementById('search-sticky-controls');
  const sidebarEl = document.querySelector('.sidebar');
  if(!stickyEl) return;
  function applyStickyOffset(){
    const h = sidebarEl ? Math.ceil(sidebarEl.getBoundingClientRect().height) : 0;
    stickyEl.style.top = `${h + 12}px`;
  }
  applyStickyOffset();
  window.addEventListener('resize', applyStickyOffset);
})();


(function initSearchFab(){
  const fab = document.getElementById('search-fab-jump');
  if(!fab) return;
  fab.addEventListener('click', () => {
    const khoPanel = document.getElementById('kho-summary-panel');
    const rawPanel = document.getElementById('raw-detail-panel');
    const target = fab.dataset.target === 'kho' ? khoPanel : rawPanel;
    if(target){
      ccSetCollapsePanelOpen(target, true); // tự mở panel trước khi cuộn tới, tránh nhảy vào chỗ đang thu gọn
      target.scrollIntoView({ behavior:'smooth', block:'start' });
    }
  });
  window.addEventListener('scroll', () => {
    if(pageSearchEl && pageSearchEl.style.display !== 'none') updateSearchFabLabel();
  }, { passive:true });
})();

function initDashboard(){
  const saved = loadStateFromStorage();

  // QUAN TRỌNG: khôi phục TẤT CẢ các biến trạng thái (planData, confirmedKiemTonItems,
  // lastCheckedMap, invSnapshotHistory...) TRƯỚC KHI gọi renderDashboard()/renderConfirmedList().
  // Lý do: renderDashboard() gọi ccCaptureInventorySnapshot() -> saveStateToStorage() như một
  // side-effect, và saveStateToStorage() đọc TRỰC TIẾP các biến toàn cục này để ghi lại vào bộ
  // nhớ (_mem). Nếu gọi render TRƯỚC khi khôi phục xong, saveStateToStorage() sẽ đọc phải giá
  // trị CŨ (rỗng) của planData/confirmedKiemTonItems/... và XOÁ MẤT dữ liệu vừa tải về từ
  // Cloud/file — dù biến sẽ được gán đúng ngay sau đó, ô nhớ _mem đã bị ghi đè mất trước rồi.
  // Đây chính là nguyên nhân Plan hay bị mất dù Cloud vẫn đang lưu đúng.
  // QUAN TRỌNG — GỐC THẬT của lỗi "dữ liệu đã xoá tự sống lại" (đã sửa nhiều lần ở chỗ khác nhưng vẫn
  // tái diễn): TẤT CẢ các dòng gán bên dưới trước đây chỉ gán biến toàn cục khi dữ liệu đã lưu KHÔNG
  // RỖNG ("if(saved.X && length>0) bien = saved.X") — nghĩa là khi dữ liệu đã lưu RỖNG (VD: Cloud vừa
  // báo về 0 dòng "Đã xác nhận" sau khi máy khác Lưu/Đặt lại), biến toàn cục KHÔNG BAO GIỜ được đặt về
  // rỗng, cứ giữ nguyên giá trị CŨ (còn đầy dữ liệu) từ lần initDashboard() TRƯỚC ĐÓ trong CÙNG phiên
  // (initDashboard() có thể chạy lại NHIỀU LẦN không qua tải trang thật, xem FileVault._runReloaders()
  // — VD: lần đầu tải trang đọc bản sao lưu cục bộ CŨ [còn dữ liệu], vài giây sau realtime nhận bản
  // Cloud MỚI [đã rỗng] và gọi lại initDashboard() lần 2, nhưng biến toàn cục vẫn bị "kẹt" ở giá trị
  // đầy từ lần 1). Ngay sau đó, renderDashboard() bên dưới gọi ccCaptureInventorySnapshot() ->
  // saveStateToStorage() như 1 side-effect, ĐỌC LẠI đúng biến toàn cục đang "kẹt" đó và GHI NGƯỢC vào
  // _mem — làm dữ liệu vừa được Cloud xoá đúng lại "sống lại" ngay trong bộ nhớ máy này, dù Cloud vẫn
  // hoàn toàn đúng. Sửa: LUÔN gán lại (kể cả khi rỗng) để mọi lần initDashboard() đều phản ánh ĐÚNG
  // trạng thái mới nhất, không còn giữ sót giá trị của lần chạy trước.
  confirmedKiemTonItems = saved.confirmed || {};
  lastCheckedMap = saved.lastCheck || {};
  invSnapshotHistory = saved.invSnapshot || {};
  manualPickedContainers = saved.manualPicked || {};
  hiddenPlanContainers = saved.hiddenContainers || {};
  contPickComments = saved.contComments || {};
  planContainerChangeInfo = saved.planChangeInfo || {};
  manualKhoOverrides = saved.manualKho || {};
  sppManualOk = saved.sppOk || {};
  scannedExtraRows = saved.scannedExtra || {};
  scannedGiSet = new Set(saved.scannedGi || []);
  giScanLog = saved.giScanLog || [];
  contShipData = saved.contShip || null;
  itemCbmLibrary = saved.itemCbm || {};
  khoGridLayouts = saved.khoGrid || {};
  confirmedHistory = saved.confirmedHistory || {};
  ktInputValues = saved.ktInputs || {};
  txTransferChecked = saved.txTransferChecked || {};
  // ccKhoResults ("Đề xuất kiểm hôm nay") — xoá sạch trước rồi mới gán lại từ saved.ccResults (cùng lý
  // do "LUÔN gán lại" ở trên): xoá sạch key cũ đảm bảo kho nào Cloud/bản lưu KHÔNG còn (đã bị xoá ở nơi
  // khác) cũng được dọn sạch ở đây, không giữ sót key "mồ côi" từ lần initDashboard() trước.
  Object.keys(ccKhoResults).forEach(k => delete ccKhoResults[k]);
  if(saved.ccResults){
    Object.keys(saved.ccResults).forEach(khoLabel => {
      const result = saved.ccResults[khoLabel];
      if(result && result.list && result.list.length) ccKhoResults[khoLabel] = result;
    });
  }
  PLAN_TYPES.forEach(type => { planData[type] = (saved.plans && saved.plans[type]) ? saved.plans[type] : null; });

  if(saved.inv){
    // QUAN TRỌNG (giống lý do ở trên): khôi phục currentFileName/dòng "Cập nhật lúc" TRƯỚC khi gọi
    // renderDashboard() — trước đây gọi SAU, nên lượt saveStateToStorage() ĐẦU TIÊN (side-effect của
    // renderDashboard()) luôn ghi currentFileName=null + dòng cập nhật rỗng vào _mem (khác hẳn bản đã
    // lưu), khiến mục "Thông tin file đã tải" LUÔN báo "có thay đổi chưa lưu" ngay khi vừa mở trang,
    // dù chẳng ai sửa gì cả.
    if(saved.meta && saved.meta.inventoryFileName){
      currentFileName = saved.meta.inventoryFileName;
      const fEl = document.getElementById('uploaded-file-line');
      if(fEl){ fEl.textContent = `File: ${currentFileName}`; fEl.title = currentFileName; }
    }
    const uEl = document.getElementById('updated-at-line');
    if(uEl && saved.meta && saved.meta.updatedAtText) uEl.textContent = saved.meta.updatedAtText;
    renderDashboard(saved.inv);
    const statusEl0 = document.getElementById('upload-status');
    if(statusEl0){ statusEl0.className = 'upload-status ok'; statusEl0.textContent = '✓ Đã khôi phục dữ liệu đã lưu trong trình duyệt này'; }
  } else {
    renderDashboard(DEFAULT_DATA);
  }

  // Từ đây chỉ còn việc CẬP NHẬT GIAO DIỆN cho khớp với các biến đã khôi phục ở trên — không
  // còn thao tác gán biến nào nữa, nên renderDashboard() phía trên không thể đọc phải giá trị cũ.
  //
  // LUÔN vẽ lại bảng "Đã xác nhận" (kể cả khi rỗng) — trước đây chỉ vẽ khi saved.confirmed KHÔNG
  // RỖNG, nên khi initDashboard() chạy lại giữa phiên (không qua tải trang thật) với dữ liệu MỚI đã
  // rỗng (VD: Cloud vừa báo máy khác đã Lưu/Đặt lại), bảng trên MÀN HÌNH không bao giờ được vẽ lại
  // về rỗng — vẫn hiện nguyên các dòng cũ từ lần vẽ trước đó, dù confirmedKiemTonItems (biến) đã
  // đúng là rỗng rồi. Đây là phần hiển thị bổ sung cho phần sửa gốc ở trên (luôn gán lại biến).
  renderConfirmedList();

  if(saved.plans){
    PLAN_TYPES.forEach(type => {
      if(saved.plans[type]){
        const statusEl = document.querySelector(`.plan-status[data-plan-status="${type}"]`);
        const btnEl = document.querySelector(`.btn-plan[data-plan="${type}"]`);
        const clearBtn = document.querySelector(`.btn-plan-clear[data-plan-clear="${type}"]`);
        if(statusEl){ statusEl.className = 'plan-status ok'; statusEl.textContent = `✓ ${planData[type].fileName} · ${planData[type].itemCount} mã · ${fmt(planData[type].totalQty)} Pcs (đã khôi phục)`; }
        if(btnEl) btnEl.classList.add('loaded');
        if(clearBtn) clearBtn.classList.add('show');
      }
    });
    renderPlanPanel();
  }

  // Khôi phục các danh sách "Tạo danh sách" (Đề xuất kiểm hôm nay) đã tạo trước đó — LUÔN gọi (kể cả
  // khi rỗng), cùng lý do đã sửa ở renderConfirmedList(): để kho nào không còn danh sách cũng được
  // vẽ lại đúng về trạng thái rỗng trên màn hình, không giữ sót khối kết quả cũ từ lần vẽ trước.
  ccInitKhoTotalsAndLabels();
  ccRestoreResultsFromStorage(saved.ccResults);

  renderKhoSearchPage();
  if(typeof updateQrGiClearBtn === 'function') updateQrGiClearBtn();
  if(typeof renderContShipUpdatedLine === 'function') renderContShipUpdatedLine();
}
initDashboard();
FileVault.registerReloader(initDashboard);

document.getElementById('btn-reset-data').addEventListener('click', () => {
  const ok = confirm('Xoá toàn bộ dữ liệu tồn kho và Plan đã lưu trong trình duyệt này, quay lại dữ liệu mặc định?\n\nThao tác này không thể hoàn tác.');
  if(!ok) return;

  clearStoredState();
  currentFileName = null;
  PLAN_TYPES.forEach(type => {
    planData[type] = null;
    const statusEl = document.querySelector(`.plan-status[data-plan-status="${type}"]`);
    const btnEl = document.querySelector(`.btn-plan[data-plan="${type}"]`);
    const clearBtn = document.querySelector(`.btn-plan-clear[data-plan-clear="${type}"]`);
    if(statusEl){ statusEl.className = 'plan-status'; statusEl.textContent = 'Chưa tải'; }
    if(btnEl) btnEl.classList.remove('loaded');
    if(clearBtn) clearBtn.classList.remove('show');
  });
  confirmedKiemTonItems = {};
  renderConfirmedList();

  ccKhoResults = {};
  CC_KHO_LIST.forEach(k => {
    const blockWrap = document.getElementById('cc-result-block-' + k.code);
    if(blockWrap) blockWrap.style.display = 'none';
  });

  renderDashboard(DEFAULT_DATA);
  renderPlanPanel();
  renderKhoSearchPage();

  const statusEl0 = document.getElementById('upload-status');
  if(statusEl0){ statusEl0.className = 'upload-status'; statusEl0.textContent = 'Đã đặt lại — Tải file .xlsx / .csv / .tsv mới để làm mới dashboard'; }
  const fEl = document.getElementById('uploaded-file-line');
  if(fEl){ fEl.textContent = 'File: Dữ liệu mặc định'; fEl.title = ''; }
  const uEl0 = document.getElementById('updated-at-line');
  if(uEl0) uEl0.textContent = 'Cập nhật lúc —';
});

// Nút "Làm mới" — chỉ tải lại dữ liệu mới nhất từ Cloud (giống bấm "Kết nối" ở mục Cloud
// trong Cài đặt), rồi làm mới toàn bộ các trang (Dashboard, Transaction, So sánh...) từ
// dữ liệu vừa tải về. Không dùng file đồng bộ trên máy.
const btnRefreshData = document.getElementById('btn-refresh-data');
if(btnRefreshData){
  btnRefreshData.addEventListener('click', async () => {
    const overlay = document.getElementById('loading-overlay');
    const loadingMsg = document.getElementById('loading-msg');
    const statusEl = document.getElementById('upload-status');
    if(typeof CloudVault === 'undefined' || !CloudVault.url || !CloudVault.token){
      if(statusEl){ statusEl.className = 'upload-status err'; statusEl.textContent = '✗ Chưa kết nối Cloud — vào Cài đặt để nhập Database URL + Database secret và bấm "Kết nối" trước.'; }
      return;
    }
    if(hasUnsavedChanges){
      const ok = confirm('Bạn đang có thay đổi CHƯA LƯU lên Cloud. Tải lại từ Cloud bây giờ có thể GHI ĐÈ MẤT các thay đổi này.\n\nBấm "Huỷ" rồi bấm nút "Lưu" trước nếu muốn giữ lại. Vẫn tải lại?');
      if(!ok) return;
    }
    btnRefreshData.disabled = true;
    if(overlay) overlay.classList.add('show');
    if(loadingMsg) loadingMsg.textContent = 'Đang tải lại dữ liệu từ Cloud…';
    try{
      const ok = await CloudVault.readAll();
      if(ok && Object.keys(ccKhoResults).length) ccRestoreResultsFromStorage(ccKhoResults);
      if(statusEl){
        statusEl.className = ok ? 'upload-status ok' : 'upload-status err';
        statusEl.textContent = ok ? `✓ Đã tải lại dữ liệu mới nhất từ Cloud và làm mới bảng (${fmtBytes(CloudVault._lastReadBytes)}).` : '✗ Không tải lại được từ Cloud — kiểm tra lại kết nối.';
      }
      if(ok) clearUnsavedChanges();
    }catch(err){
      console.error('Lỗi khi làm mới dữ liệu:', err);
      if(statusEl){ statusEl.className = 'upload-status err'; statusEl.textContent = `✗ Lỗi khi làm mới: ${err.message}`; }
    }finally{
      btnRefreshData.disabled = false;
      if(overlay) overlay.classList.remove('show');
    }
  });
}

// Nút "Lưu" — CHỈ nơi duy nhất đẩy dữ liệu hiện tại lên Cloud. Ghi ngay lập tức (không debounce),
// và sau khi ghi xong, dữ liệu đó được coi là "đã lưu" cho tới khi có thay đổi mới.
const btnSaveCloud = document.getElementById('btn-save-cloud');
if(btnSaveCloud){
  btnSaveCloud.addEventListener('click', async () => {
    const statusEl = document.getElementById('upload-status');
    // Không có gì thay đổi kể từ lần lưu trước -> bỏ qua, không gửi request lên Cloud nữa. Tránh
    // vừa tốn request vô ích vừa là nguyên nhân hay gặp lỗi "Unauthorized"/thất bại giả khi bấm
    // "Lưu" liên tục nhiều lần dù dữ liệu không đổi (Cloud đôi khi trả lỗi tạm thời
    // nếu gọi dồn dập).
    if(!hasUnsavedChanges){
      if(statusEl && !statusEl.classList.contains('err')){
        statusEl.className = 'upload-status ok';
        statusEl.textContent = '✓ Không có gì mới để lưu — dữ liệu đã ở trên Cloud từ trước.';
      }
      return;
    }
    if(typeof CloudVault !== 'undefined' && CloudVault.url && CloudVault.token){
      btnSaveCloud.disabled = true;
      if(statusEl){ statusEl.className = 'upload-status'; statusEl.textContent = 'Đang kiểm tra dữ liệu mới nhất trên Cloud…'; }
      try{
        clearTimeout(CloudVault._writeTimer);
        clearTimeout(CloudVault._retryTimer);
        // Gộp trước phần "Đã xác nhận / KT đang nhập dở / GI đã quét / Lịch sử" từ Cloud vào máy này
        // — để không xoá mất phần người khác vừa lưu (xem giải thích ở mergeConfirmedDataFromCloud).
        const cloudData = await CloudVault.peek();
        if(cloudData){
          mergeConfirmedDataFromCloud(cloudData);
          // Máy này KHÔNG tự tải file tồn kho mới nào — nếu Cloud đang có bản tồn kho KHÁC (do máy
          // khác vừa Lưu file mới hơn), lấy đúng bản đó về trước, tránh việc Lưu ở đây (vì 1 lý do
          // khác, VD: vừa xác nhận 1 dòng kiểm tồn) lỡ đẩy bản tồn kho CŨ đang cache trên máy này đè
          // mất bản mới trên Cloud.
          if(!_localInventoryDirty && cloudData[STORAGE_KEY_INVENTORY] !== undefined && cloudData[STORAGE_KEY_INVENTORY] !== _mem[STORAGE_KEY_INVENTORY]){
            try{
              currentData = cloudData[STORAGE_KEY_INVENTORY] ? JSON.parse(cloudData[STORAGE_KEY_INVENTORY], jsonReviver) : null;
              renderDashboard(currentData);
              const cloudMeta = cloudData[STORAGE_KEY_META] ? JSON.parse(cloudData[STORAGE_KEY_META]) : null;
              currentFileName = cloudMeta && cloudMeta.inventoryFileName ? cloudMeta.inventoryFileName : currentFileName;
              const fEl2 = document.getElementById('uploaded-file-line');
              if(fEl2){ fEl2.textContent = `File: ${currentFileName || 'Dữ liệu mặc định'}`; fEl2.title = currentFileName || ''; }
              // Lấy ĐÚNG dòng "Cập nhật lúc" theo bản Cloud vừa tải về (thời điểm file đó THỰC SỰ
              // được tải lên ở máy khác) — KHÔNG dùng touchUpdatedAt() ở đây vì hàm đó luôn ghi giờ
              // HIỆN TẠI (lúc máy này đang bấm Lưu), sai với thời điểm tải lên thật.
              const uEl2 = document.getElementById('updated-at-line');
              if(uEl2) uEl2.textContent = (cloudMeta && cloudMeta.updatedAtText) || uEl2.textContent;
              if(Object.keys(ccKhoResults).length) ccRestoreResultsFromStorage(ccKhoResults);
            }catch(e){ console.warn('Không lấy được tồn kho mới nhất từ Cloud trước khi lưu:', e); }
          }
          // Tương tự tồn kho: máy này KHÔNG tự tải file Ship mới nào — nếu Cloud đang có bản Ship KHÁC
          // (do máy khác vừa cập nhật), lấy đúng bản đó về trước khi lưu.
          if(!_localShipDirty && cloudData[STORAGE_KEY_CONT_SHIP] !== undefined && cloudData[STORAGE_KEY_CONT_SHIP] !== _mem[STORAGE_KEY_CONT_SHIP]){
            try{
              contShipData = cloudData[STORAGE_KEY_CONT_SHIP] ? contShipDeserialize(JSON.parse(cloudData[STORAGE_KEY_CONT_SHIP])) : null;
              renderPlanPanel();
              if(typeof renderContShipUpdatedLine === 'function') renderContShipUpdatedLine();
            }catch(e){ console.warn('Không lấy được dữ liệu Ship mới nhất từ Cloud trước khi lưu:', e); }
          }
          // Tương tự: máy này KHÔNG tự sửa Grid sơ đồ kho tuỳ chỉnh nào — nếu Cloud đang có bản KHÁC,
          // lấy đúng bản đó về trước khi lưu.
          if(!_localKhoGridDirty && cloudData[STORAGE_KEY_KHO_GRID] !== undefined && cloudData[STORAGE_KEY_KHO_GRID] !== _mem[STORAGE_KEY_KHO_GRID]){
            try{
              khoGridLayouts = cloudData[STORAGE_KEY_KHO_GRID] ? JSON.parse(cloudData[STORAGE_KEY_KHO_GRID]) : {};
              if(sodo3bGridMode) renderSodo3bCustomGrid();
            }catch(e){ console.warn('Không lấy được lưới sơ đồ kho mới nhất từ Cloud trước khi lưu:', e); }
          }
          // Tương tự tồn kho/Ship: máy này KHÔNG tự đổi Kho thủ công/đánh dấu Pick xong tay/ẩn container
          // nào — nếu Cloud đang có bản KHÁC (do máy khác vừa đổi), lấy đúng bản đó về trước khi lưu.
          if(!_localContOverridesDirty){
            try{
              if(cloudData[STORAGE_KEY_MANUAL_KHO] !== undefined && cloudData[STORAGE_KEY_MANUAL_KHO] !== _mem[STORAGE_KEY_MANUAL_KHO]){
                manualKhoOverrides = cloudData[STORAGE_KEY_MANUAL_KHO] ? JSON.parse(cloudData[STORAGE_KEY_MANUAL_KHO]) : {};
              }
              if(cloudData[STORAGE_KEY_MANUAL_PICKED] !== undefined && cloudData[STORAGE_KEY_MANUAL_PICKED] !== _mem[STORAGE_KEY_MANUAL_PICKED]){
                manualPickedContainers = cloudData[STORAGE_KEY_MANUAL_PICKED] ? JSON.parse(cloudData[STORAGE_KEY_MANUAL_PICKED]) : {};
              }
              if(cloudData[STORAGE_KEY_HIDDEN_CONT] !== undefined && cloudData[STORAGE_KEY_HIDDEN_CONT] !== _mem[STORAGE_KEY_HIDDEN_CONT]){
                hiddenPlanContainers = cloudData[STORAGE_KEY_HIDDEN_CONT] ? JSON.parse(cloudData[STORAGE_KEY_HIDDEN_CONT]) : {};
              }
              if(cloudData[STORAGE_KEY_CONT_COMMENTS] !== undefined && cloudData[STORAGE_KEY_CONT_COMMENTS] !== _mem[STORAGE_KEY_CONT_COMMENTS]){
                contPickComments = cloudData[STORAGE_KEY_CONT_COMMENTS] ? JSON.parse(cloudData[STORAGE_KEY_CONT_COMMENTS]) : {};
              }
              if(cloudData[STORAGE_KEY_SPP_OK] !== undefined && cloudData[STORAGE_KEY_SPP_OK] !== _mem[STORAGE_KEY_SPP_OK]){
                sppManualOk = cloudData[STORAGE_KEY_SPP_OK] ? JSON.parse(cloudData[STORAGE_KEY_SPP_OK]) : {};
              }
              renderPlanPanel();
            }catch(e){ console.warn('Không lấy được tuỳ chỉnh container mới nhất từ Cloud trước khi lưu:', e); }
          }
          saveStateToStorage();
          renderConfirmedList();
          renderKhoSearchPage();
        }
        if(statusEl){ statusEl.className = 'upload-status'; statusEl.textContent = 'Đang lưu lên Cloud…'; }
        await CloudVault.writeAll();
        clearUnsavedChanges();
        if(statusEl){ statusEl.className = 'upload-status ok'; statusEl.textContent = `✓ Đã gộp dữ liệu mới nhất và lưu lên Cloud lúc ${fmtDateTime(new Date())} (${fmtBytes(CloudVault._lastWriteBytes)}).`; }
      }catch(err){
        console.error('Lỗi khi lưu lên Cloud:', err);
        if(statusEl){ statusEl.className = 'upload-status err'; statusEl.textContent = `✗ Lưu lên Cloud thất bại: ${err.message} — dữ liệu vẫn đang giữ ở "chưa lưu", thử bấm Lưu lại.`; }
      }finally{
        btnSaveCloud.disabled = false;
      }
      return;
    }
    if(typeof FileVault !== 'undefined' && FileVault.handle){
      btnSaveCloud.disabled = true;
      if(statusEl){ statusEl.className = 'upload-status'; statusEl.textContent = 'Đang lưu vào file đồng bộ trên máy…'; }
      try{
        clearTimeout(FileVault._writeTimer);
        await FileVault.writeAll();
        clearUnsavedChanges();
        if(statusEl){ statusEl.className = 'upload-status ok'; statusEl.textContent = `✓ Đã lưu vào file "${FileVault.handle.name}" lúc ${fmtDateTime(new Date())}.`; }
      }catch(err){
        console.error('Lỗi khi lưu vào file đồng bộ:', err);
        if(statusEl){ statusEl.className = 'upload-status err'; statusEl.textContent = `✗ Lưu vào file thất bại: ${err.message}`; }
      }finally{
        btnSaveCloud.disabled = false;
      }
      return;
    }
    if(statusEl){ statusEl.className = 'upload-status err'; statusEl.textContent = '✗ Chưa kết nối Cloud và chưa chọn file đồng bộ — vào Cài đặt để kết nối một trong hai trước khi Lưu.'; }
  });
}

/* ============ XUẤT / NHẬP TRẠNG THÁI (BACKUP JSON) ============
   Cho phép tải toàn bộ dữ liệu tồn kho + Plan + danh sách đã xác nhận ra 1 file .json
   để chuyển sang máy/trình duyệt khác, hoặc gộp danh sách đã xác nhận giữa nhiều người kiểm kho. */
function updatePlanUiAfterImport(type){
  const statusEl = document.querySelector(`.plan-status[data-plan-status="${type}"]`);
  const btnEl = document.querySelector(`.btn-plan[data-plan="${type}"]`);
  const clearBtn = document.querySelector(`.btn-plan-clear[data-plan-clear="${type}"]`);
  if(planData[type]){
    if(statusEl){ statusEl.className = 'plan-status ok'; statusEl.textContent = `✓ ${planData[type].fileName} · ${planData[type].itemCount} mã · ${fmt(planData[type].totalQty)} Pcs (đã nhập)`; }
    if(btnEl) btnEl.classList.add('loaded');
    if(clearBtn) clearBtn.classList.add('show');
  } else {
    if(statusEl){ statusEl.className = 'plan-status'; statusEl.textContent = 'Chưa tải'; }
    if(btnEl) btnEl.classList.remove('loaded');
    if(clearBtn) clearBtn.classList.remove('show');
  }
}

// Theo yêu cầu: dữ liệu CHỈ được ghi lên Cloud khi người dùng bấm nút "Lưu" (btn-save-cloud) —
// không còn cơ chế tự động đẩy lên Cloud lúc đóng tab/chuyển tab nữa (kể cả sendBeacon), để
// tránh mọi khả năng ghi đè ngoài ý muốn. Thay vào đó, nếu còn thay đổi chưa lưu, trình duyệt sẽ
// tự hỏi xác nhận trước khi rời trang (hộp thoại chuẩn của trình duyệt, không thể tuỳ biến nội dung).
window.addEventListener('beforeunload', (e) => {
  saveStateToStorage(); // vẫn cập nhật _mem cục bộ (KHÔNG đẩy lên Cloud)
  if(hasUnsavedChanges){
    e.preventDefault();
    e.returnValue = 'Bạn có thay đổi chưa lưu lên Cloud. Rời trang bây giờ có thể mất các thay đổi này — hãy bấm "Lưu" trước.';
    return e.returnValue;
  }
});

/* ============================================================
   ============  TAB "TRANSACTION" (thống kê như sheet View)  ============
   ============================================================
   Logic tái hiện lại 3 pivot table của sheet "View" trong file Excel
   tổng hợp (Nhut_X.xlsm):
     - RECEIVE  : Count of Transaction Qty, nhóm theo Kho xuất / Transaction
                  Type / Item / Locator — lọc Transaction Type = RECEIVE.
     - TRANSFER : Sum of Flag, nhóm theo Kho xuất / Item / Locator / User —
                  lọc Menu Name = "Move Pallet" và chỉ tính dòng SL dương
                  (Flag=1, tức lượt CHUYỂN ĐẾN, để không đếm trùng 2 dòng +/-
                  của cùng 1 giao dịch chuyển pallet).
     - PICKING  : Sum of Flag, nhóm theo Kho xuất / Locator / Item / User —
                  lọc Menu Name = "Pick Order", cùng nguyên tắc Flag=1.
   "Kho xuất" (KHO XUẤT) = tra cứu Kho của User Name thực hiện giao dịch,
   theo bảng Master (User Name -> Kho) nhúng sẵn dưới đây, lấy từ sheet
   Master của file Nhut_X.xlsm. User không có trong bảng Master sẽ hiển thị "—".
*/
const TX_MASTER_DEFAULT = {
  "Nguyễn Quang Huy": "3B",
  "Tạ Ngọc Anh": "SHIP",
  "Trần Văn Lâm": "3A",
  "Nguyễn Công Minh": "3A",
  "Phạm Hữu Dư": "2B",
  "Lê Thanh Phong": "SHIP",
  "Nguyễn Duyên Thọa": "3B",
  "Võ Trung Tín": "3A",
  "Huỳnh Ngọc Phong": "3B",
  "Bùi Anh Dũng": "3A",
  "Nguyễn Văn Tới": "3B"
};
const TX_MASTER_STORAGE_KEY = 'tn5_transaction_master_v1';
let txMasterMap = {}; // { "User Name": "Kho" } — chỉnh sửa được qua UI

const TX_STORAGE_KEY = 'tn5_transaction_v1';
let txState = null; // { records:[...], receive:[...], transfer:[...], picking:[...], kpi:{...}, fileName, updatedAtText }
const txSort = {
  receive: { key: 'total', dir: -1 },
  transfer: { key: 'total', dir: -1 },
  picking: { key: 'total', dir: -1 }
};

function txItemText(raw){
  const s = (raw === null || raw === undefined) ? '' : String(raw).trim();
  if(!s) return '';
  return /^\d+$/.test(s) ? s.padStart(9, '0') : s;
}

function txNorm(s){
  return (s === null || s === undefined) ? '' : String(s).trim();
}

function txExtractSheetRows(workbook){
  const headerCands = ['transaction type'];
  const menuCands = ['menu name'];
  let best = null;
  for(const name of workbook.SheetNames){
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[name], {header:1, raw:true, defval:null});
    if(!rows.length) continue;
    const maxScan = Math.min(rows.length, 10);
    for(let i=0;i<maxScan;i++){
      const row = rows[i];
      if(!row) continue;
      if(findCol(row, headerCands) !== -1 && findCol(row, menuCands) !== -1){
        if(!best || rows.length - i > best.rows.length - best.hIdx){ best = {name, rows, hIdx:i}; }
        break;
      }
    }
  }
  if(!best) throw new Error('Không tìm thấy cột "Transaction Type" / "Menu Name" trong file.');
  const rows = best.hIdx > 0 ? best.rows.slice(best.hIdx) : best.rows;
  return { name: best.name, rows };
}

function txParseTxDateTime(s){
  if(!s) return null;
  const str = String(s).trim();
  const m = str.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if(!m) return null;
  const mon = MONTHS[m[2].toLowerCase()];
  if(mon === undefined) return null;
  const d = new Date(Number(m[3]), mon, Number(m[1]), Number(m[4]), Number(m[5]), m[6] ? Number(m[6]) : 0);
  return isNaN(d.getTime()) ? null : d;
}
function txFormatTimeRange(minDt, maxDt){
  if(!minDt || !maxDt) return '—';
  const p = n => String(n).padStart(2,'0');
  const timeFmt = d => `${p(d.getHours())}:${p(d.getMinutes())}`;
  const dateFmt = d => `${p(d.getDate())}/${p(d.getMonth()+1)}`;
  const sameDay = minDt.toDateString() === maxDt.toDateString();
  if(sameDay) return `${timeFmt(minDt)}–${timeFmt(maxDt)}`;
  return `${dateFmt(minDt)} ${timeFmt(minDt)} – ${dateFmt(maxDt)} ${timeFmt(maxDt)}`;
}

function txParseTransactionRecords(rows){
  if(!rows.length) throw new Error('File không có dữ liệu.');
  const headers = rows[0];
  const colType = findCol(headers, ['transaction type']);
  const colMenu = findCol(headers, ['menu name']);
  const colLocator = findCol(headers, ['locator name']);
  const colItem = findCol(headers, ['item no', 'item no.', 'item number']);
  const colQty = findCol(headers, ['transaction qty']);
  const colUser = findCol(headers, ['user name']);
  const colDate = findCol(headers, ['transaction date']);
  const colSetId = findCol(headers, ['transaction set id']);
  const colRef = findCol(headers, ['reference']);
  // Cột GI No. — KHÔNG bắt buộc (không phải file Transaction nào cũng có sẵn cột này, khác với file
  // tồn kho luôn có) — cùng nhóm alias tên cột đang dùng bên đọc file tồn kho (xem colGI ở trên) để
  // nhận diện nhất quán dù tiêu đề cột ghi khác nhau chút ít giữa các lần xuất file.
  const colGi = findCol(headers, ['gi no', 'gi no.', 'gi number', 'gi']);
  if(colType === -1 || colMenu === -1 || colLocator === -1 || colItem === -1 || colQty === -1 || colUser === -1){
    throw new Error('File thiếu cột bắt buộc (Transaction Type / Menu Name / Locator Name / Item No / Transaction Qty / User Name).');
  }

  const records = [];
  for(let i=1;i<rows.length;i++){
    const r = rows[i];
    if(!r) continue;
    const transType = txNorm(r[colType]);
    const menuName = txNorm(r[colMenu]);
    if(!transType && !menuName) continue;
    const locator = txNorm(r[colLocator]);
    const item = txItemText(r[colItem]);
    const user = txNorm(r[colUser]);
    const qty = parseFloat(r[colQty]);
    const flag = (!isNaN(qty) && qty >= 1) ? 1 : 0;
    const dt = colDate !== -1 ? txParseTxDateTime(r[colDate]) : null;
    const setId = colSetId !== -1 ? txNorm(r[colSetId]) : '';
    const reference = colRef !== -1 ? txNorm(r[colRef]) : '';
    const gi = colGi !== -1 ? txNorm(r[colGi]) : '';
    records.push({ transType, menuName, item, locator, user, flag, qty: isNaN(qty) ? 0 : qty, dt, setId, reference, gi });
  }
  return records;
}

// Đọc thẳng Kho của 1 locator từ dữ liệu tồn kho hiện có (kho_detail) — đây là dữ liệu THẬT, đáng tin
// hơn nhiều so với suy đoán qua bảng Master (User -> Kho). Chỉ khi locator không có trong tồn kho hiện
// tại (VD: vị trí trung chuyển/loading đã hết hàng) mới cần suy ra từ tiền tố tên locator (2B/3A/3B —
// các tiền tố này đủ rõ ràng, không suy đoán mù).
function buildLocatorKhoMap(){
  const map = {};
  if(currentData && currentData.kho_detail){
    Object.keys(currentData.kho_detail).forEach(kho => {
      (currentData.kho_detail[kho] || []).forEach(entry => {
        const locator = entry[2];
        if(locator) map[String(locator).trim().toUpperCase()] = kho;
      });
    });
  }
  return map;
}
function guessKhoFromLocatorPrefix(locator){
  const s = String(locator || '').trim().toUpperCase();
  if(!s) return null;
  if(/^D?3B/.test(s)) return 'Kho 3B';
  if(/^D?3A/.test(s)) return 'Kho 3A';
  if(/^D?2B/.test(s)) return 'Kho 2B';
  // DG2 (VD "DG2-Loading") — khu load hàng RIÊNG của Kho 2B, KHÁC với "Kho DG1" (1 kho hoàn toàn
  // riêng biệt, đã có trong kho_order) — đây là domain-knowledge do người dùng xác nhận trực tiếp
  // ("D2B và DG2 cùng là kho 2B"), không phải suy đoán từ quy ước đặt tên chung, nên chỉ khớp đúng
  // "DG2", KHÔNG mở rộng sang DG1/DG3... (những tiền tố đó vẫn để "—" như cũ, tránh đoán bừa).
  if(/^DG2/.test(s)) return 'Kho 2B';
  return null; // các tiền tố khác (DG1/DG3...) không đủ rõ để đoán — để "—" thay vì đoán bừa
}
function resolveKhoForLocator(locator, lookupMap){
  const norm = String(locator || '').trim().toUpperCase();
  if(!norm) return '—';
  const fromData = lookupMap[norm];
  if(fromData) return fromData.replace('Kho ', '');
  const guess = guessKhoFromLocatorPrefix(norm);
  return guess ? guess.replace('Kho ', '') : '—';
}

function txBuildStatsFromRecords(records, masterMap){
  const locatorKhoMap = buildLocatorKhoMap();
  const receiveMap = new Map();
  const transferMap = new Map();
  const pickingMap = new Map();
  const itnEntries = []; // theo dõi riêng ITN Transfer / ITN Receiving theo Reference — không gộp nhóm
  let countReceive = 0, countTransfer = 0, countPicking = 0;

  // Ghép các dòng cùng "Transaction Set ID" lại thành 1 giao dịch — mỗi lần chuyển pallet thường
  // ghi 2 dòng: 1 dòng SL âm tại vị trí XUẤT (nơi lấy đi) và 1 dòng SL dương tại vị trí ĐẾN (nơi
  // chuyển tới). Ghép đúng cặp này để lấy được Locator xuất / Locator đến thật, thay vì đoán qua
  // bảng Master (User -> Kho) như trước.
  const bySetId = new Map();
  records.forEach(rec => {
    const key = rec.setId || Symbol('no-set-id-' + Math.random());
    if(!bySetId.has(key)) bySetId.set(key, []);
    bySetId.get(key).push(rec);
  });

  for(const group of bySetId.values()){
    const first = group[0];
    const { transType, menuName, item: itemText, user } = first;
    const negRow = group.find(r => r.qty < 0);
    const posRow = group.find(r => r.qty > 0);
    const locatorXuat = negRow ? negRow.locator : (transType === 'SHIP' ? first.locator : '');
    const locatorDen = posRow ? posRow.locator : (transType === 'RECEIVE' ? first.locator : '');
    const dt = first.dt || (negRow && negRow.dt) || (posRow && posRow.dt) || null;
    const qty = Math.abs((posRow || negRow || first).qty || 0);
    const menuLower = menuName.toLowerCase();
    const isPicking = menuLower.startsWith('pick(') || menuLower === 'pick order';
    const reference = first.reference || (negRow && negRow.reference) || (posRow && posRow.reference) || '';

    // ITN Transfer = chuyển hàng ĐI (ra khỏi kho, đưa vào khu ITN) — ITN Receiving = NHẬN hàng về
    // (từ khu ITN nhập lại vào kho). Theo dõi riêng theo từng Reference (mã ITN/Seal) để xem đúng
    // trình tự các lượt chuyển/nhận của cùng 1 lô ITN.
    if(menuName === 'ITN Transfer' || menuName === 'ITN Receiving'){
      itnEntries.push({
        reference: reference || '(không có Reference)',
        menuName,
        loai: menuName === 'ITN Transfer' ? 'Chuyển đi' : 'Nhận',
        item: itemText,
        locatorXuat: locatorXuat || '—',
        locatorDen: locatorDen || '—',
        user,
        qty,
        dt
      });
    }

    if(transType === 'RECEIVE'){
      countReceive++;
      const khoXuat = resolveKhoForLocator(locatorDen || first.locator, locatorKhoMap);
      const key = [khoXuat, transType, itemText, locatorDen || first.locator, user].join('||');
      const cur = receiveMap.get(key);
      if(cur) cur.total++;
      else receiveMap.set(key, { khoXuat, transType, item: itemText, locator: locatorDen || first.locator, user, total: 1 });
      continue;
    }

    if(!menuName) continue; // SHIP / dòng không có Menu Name — không tính vào Transfer hay Picking

    if(isPicking){
      countPicking++;
      const khoXuat = resolveKhoForLocator(locatorXuat, locatorKhoMap);
      // Bỏ Locator xuất khỏi tiêu chí nhóm — chỉ còn Kho xuất / Locator đến / Item / User.
      const key = [khoXuat, locatorDen || '—', itemText, user].join('||');
      const crCodes = (reference.match(/CR\d+/gi) || []).map(c => c.toUpperCase());
      const cur = pickingMap.get(key);
      if(cur){
        cur.total++;
        crCodes.forEach(c => cur.contSet.add(c));
      } else {
        pickingMap.set(key, { khoXuat, locatorDen: locatorDen || '—', item: itemText, user, total: 1, contSet: new Set(crCodes) });
      }
    } else {
      countTransfer++;
      const khoXuat = resolveKhoForLocator(locatorXuat, locatorKhoMap);
      const refKey = reference || '(không có Reference)';
      // Không đưa Locator xuất vào tiêu chí nhóm — cùng mã + cùng chuyến (Reference) thì gộp làm 1
      // dòng, dù pallet nằm rải ở nhiều vị trí xuất khác nhau. Vẫn ghi nhận lại đầy đủ các vị trí đó
      // để hiển thị (cột Locator xuất sẽ liệt kê tất cả, cách nhau bởi dấu phẩy).
      const key = [khoXuat, menuName, itemText, locatorDen || '—', user, refKey].join('||');
      const cur = transferMap.get(key);
      if(cur){
        cur.total++;
        cur.qty += qty;
        if(locatorXuat) cur.locatorXuatSet.add(locatorXuat);
        if(dt && (!cur.minDt || dt < cur.minDt)) cur.minDt = dt;
        if(dt && (!cur.maxDt || dt > cur.maxDt)) cur.maxDt = dt;
      } else {
        transferMap.set(key, {
          khoXuat, menuName, item: itemText,
          locatorXuatSet: new Set(locatorXuat ? [locatorXuat] : []),
          locatorDen: locatorDen || '—', user, reference: refKey,
          total: 1, qty, minDt: dt || null, maxDt: dt || null
        });
      }
    }
  }

  const receive = Array.from(receiveMap.values());

  // Gán "Chuyến" cho Transfer — mỗi Reference riêng là 1 chuyến, đánh số theo thời gian sớm nhất
  // của Reference đó, tăng dần bắt đầu từ Chuyến 1.
  const transferRaw = Array.from(transferMap.values());
  const chuyenOrder = [...new Set(transferRaw.map(r => r.reference))]
    .map(ref => {
      const minDt = transferRaw.filter(r => r.reference === ref).reduce((min, r) => (r.minDt && (!min || r.minDt < min)) ? r.minDt : min, null);
      return { ref, minDt };
    })
    .sort((a, b) => {
      if(a.minDt && b.minDt) return a.minDt - b.minDt;
      if(a.minDt) return -1;
      if(b.minDt) return 1;
      return 0;
    });
  const chuyenNoMap = new Map(chuyenOrder.map((c, idx) => [c.ref, idx + 1]));
  const transfer = transferRaw.map(r => {
    const { locatorXuatSet, ...rest } = r;
    const locList = [...locatorXuatSet].sort();
    return {
      ...rest,
      locatorXuat: locList.length ? locList.join(', ') : '—',
      chuyenNo: chuyenNoMap.get(r.reference),
      chuyen: `Chuyến ${chuyenNoMap.get(r.reference)}`
    };
  });
  const picking = Array.from(pickingMap.values()).map(r => {
    const { contSet, ...rest } = r;
    // "reference" hiển thị đúng danh sách mã CRxxxxx đã gộp vào "Số lượng cont" của dòng này (xếp thứ
    // tự chữ-số cho dễ nhìn) — theo yêu cầu, để biết CHÍNH XÁC container nào đã được tính vào con số đó.
    const contCodesSorted = [...(contSet || [])].sort();
    return { ...rest, contCodes: contCodesSorted, reference: contCodesSorted.join(', '), contCount: contSet ? contSet.size : 0 };
  });

  // "Xe Trung Chuyển" — gộp nhóm riêng ITN Transfer (Chuyển đi) và ITN Receiving (Nhận) theo
  // Item + Locator xuất + Locator đến + Chuyến (cùng Reference). Đánh số Chuyến dùng chung 1 mốc
  // thời gian cho cả 2 chiều (Chuyển đi & Nhận cùng Reference thì cùng số Chuyến, dễ đối chiếu).
  const itnChuyenOrder = [...new Set(itnEntries.map(e => e.reference))]
    .map(ref => {
      const minDt = itnEntries.filter(e => e.reference === ref).reduce((min, e) => (e.dt && (!min || e.dt < min)) ? e.dt : min, null);
      return { ref, minDt };
    })
    .sort((a, b) => {
      if(a.minDt && b.minDt) return a.minDt - b.minDt;
      if(a.minDt) return -1;
      if(b.minDt) return 1;
      return 0;
    });
  const itnChuyenNoMap = new Map(itnChuyenOrder.map((c, idx) => [c.ref, idx + 1]));

  // locatorField: field nào được giữ lại làm cột "vị trí" duy nhất của bảng đó — bên Chuyển đi giữ
  // Locator đến (nơi hàng tới, ví dụ bãi ITN — ổn định), bên Nhận giữ Locator xuất (bãi ITN nơi lấy
  // về — cũng ổn định); cột còn lại (nơi lưu trữ gốc/đích lẻ tẻ, đổi liên tục) bị bỏ vì không hữu ích
  // để nhóm. Cả 2 bảng đều hiển thị chung 1 cột, đặt tên "Locator đến" cho nhất quán.
  function buildItnGroup(menuNameWanted, locatorField){
    const map = new Map();
    itnEntries.filter(e => e.menuName === menuNameWanted).forEach(e => {
      const locVal = e[locatorField];
      const key = [e.item, locVal, e.reference].join('||');
      const cur = map.get(key);
      if(cur){
        cur.total++;
        cur.qty += e.qty;
        cur.users.add(e.user);
        if(e.dt && (!cur.minDt || e.dt < cur.minDt)) cur.minDt = e.dt;
        if(e.dt && (!cur.maxDt || e.dt > cur.maxDt)) cur.maxDt = e.dt;
      } else {
        map.set(key, {
          item: e.item, locator: locVal, reference: e.reference,
          users: new Set([e.user]), total: 1, qty: e.qty, minDt: e.dt || null, maxDt: e.dt || null
        });
      }
    });
    return Array.from(map.values())
      .map(r => ({
        ...r,
        user: [...r.users].join(', '),
        chuyenNo: itnChuyenNoMap.get(r.reference),
        chuyen: `Chuyến ${itnChuyenNoMap.get(r.reference)}`
      }))
      .sort((a, b) => (a.chuyenNo||0) - (b.chuyenNo||0));
  }
  const itnTransferGroups = buildItnGroup('ITN Transfer', 'locatorDen');
  const itnReceivingGroups = buildItnGroup('ITN Receiving', 'locatorXuat');

  return {
    receive, transfer, picking, itnTransferGroups, itnReceivingGroups,
    kpi: {
      nRows: records.length,
      countReceive, countTransfer, countPicking,
      receiveGroups: receive.length,
      transferGroups: transfer.length,
      pickingGroups: picking.length,
      transferTotal: transfer.reduce((s,r)=>s+r.total,0),
      pickingTotal: picking.reduce((s,r)=>s+r.total,0)
    }
  };
}

function escAttr(s){
  return escHtml(String(s===null||s===undefined?'':s)).replace(/"/g,'&quot;');
}

function txMasterLoad(){
  if(STORAGE_OK){
    try{
      const raw = LS.getItem(TX_MASTER_STORAGE_KEY);
      if(raw){ const obj = JSON.parse(raw); if(obj && typeof obj === 'object') return obj; }
    }catch(err){ console.warn('Không đọc được bảng Master đã lưu:', err); }
  }
  return { ...TX_MASTER_DEFAULT };
}
function txMasterSave(){
  if(!STORAGE_OK) return;
  try{ LS.setItem(TX_MASTER_STORAGE_KEY, JSON.stringify(txMasterMap)); }
  catch(err){ console.warn('Không lưu được bảng Master:', err); }
}
function txRecomputeFromRecords(){
  if(!txState || !txState.records) return;
  const stats = txBuildStatsFromRecords(txState.records, txMasterMap);
  txState.receive = stats.receive;
  txState.transfer = stats.transfer;
  txState.picking = stats.picking;
  txState.itnTransferGroups = stats.itnTransferGroups;
  txState.itnReceivingGroups = stats.itnReceivingGroups;
  txState.kpi = stats.kpi;
  txApplyDefaultFilters();
  renderTransactionPage();
  txSaveToStorage();
}

function renderMasterTable(){
  const tbody = document.getElementById('tx-master-tbody');
  const emptyEl = document.getElementById('tx-master-empty');
  const summaryEl = document.getElementById('tx-master-summary');
  const searchEl = document.getElementById('tx-master-search');
  if(!tbody) return;
  const query = searchEl ? removeDiacritics(searchEl.value.toLowerCase().trim()) : '';
  let entries = Object.entries(txMasterMap);
  entries.sort((a,b) => a[0].localeCompare(b[0], 'vi'));
  if(query){
    entries = entries.filter(([u,k]) =>
      removeDiacritics(String(u).toLowerCase()).includes(query) ||
      removeDiacritics(String(k).toLowerCase()).includes(query)
    );
  }

  if(!entries.length){
    tbody.innerHTML = '';
    if(emptyEl) emptyEl.style.display = 'block';
    if(summaryEl) summaryEl.textContent = Object.keys(txMasterMap).length ? 'Không có user nào khớp tìm kiếm' : 'Chưa có user nào';
    return;
  }
  if(emptyEl) emptyEl.style.display = 'none';
  if(summaryEl) summaryEl.textContent = `${entries.length} user`;

  tbody.innerHTML = entries.map(([user, kho]) => `
    <tr data-user="${escAttr(user)}">
      <td><input type="text" class="tx-master-user" value="${escAttr(user)}" style="width:100%; border:1px solid var(--line); border-radius:6px; padding:6px 8px; font:inherit; background:#fff;"></td>
      <td><input type="text" class="tx-master-kho" value="${escAttr(kho)}" style="width:100%; border:1px solid var(--line); border-radius:6px; padding:6px 8px; font:inherit; background:#fff;"></td>
      <td style="text-align:center;">
        <button class="tx-master-del" title="Xoá user" type="button" style="border:none;background:none;cursor:pointer;color:#d6394b;padding:4px;">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
        </button>
      </td>
    </tr>
  `).join('');
}

const TX_MASTER_COLLAPSE_KEY = 'tn5_transaction_master_collapsed_v1';
let txMasterCollapsed = true;

function txSetMasterCollapsed(collapsed){
  txMasterCollapsed = collapsed;
  const body = document.getElementById('tx-master-collapsible');
  const icon = document.getElementById('tx-master-chevron-icon');
  if(body) body.style.display = collapsed ? 'none' : 'block';
  if(icon) icon.style.transform = collapsed ? 'rotate(0deg)' : 'rotate(90deg)';
  if(STORAGE_OK){
    try{ LS.setItem(TX_MASTER_COLLAPSE_KEY, collapsed ? '1' : '0'); }
    catch(err){}
  }
}
function txLoadMasterCollapsed(){
  if(!STORAGE_OK) return true;
  try{
    const raw = LS.getItem(TX_MASTER_COLLAPSE_KEY);
    return raw === null ? true : raw === '1';
  }catch(err){ return true; }
}

function txMasterWire(){
  const tbody = document.getElementById('tx-master-tbody');
  const searchEl = document.getElementById('tx-master-search');
  const addBtn = document.getElementById('btn-master-add');
  const resetBtn = document.getElementById('btn-master-reset');
  const toggleBtn = document.getElementById('tx-master-toggle');
  const titleClick = document.getElementById('tx-master-title-click');
  if(!tbody) return;

  if(toggleBtn) toggleBtn.addEventListener('click', (e) => { e.stopPropagation(); txSetMasterCollapsed(!txMasterCollapsed); });
  if(titleClick) titleClick.addEventListener('click', () => txSetMasterCollapsed(!txMasterCollapsed));

  tbody.addEventListener('change', (e) => {
    if(!e.target.matches('.tx-master-user, .tx-master-kho')) return;
    const tr = e.target.closest('tr');
    if(!tr) return;
    const originalUser = tr.dataset.user;
    const userInput = tr.querySelector('.tx-master-user');
    const khoInput = tr.querySelector('.tx-master-kho');
    const newUser = userInput.value.trim();
    const newKho = khoInput.value.trim();
    if(!newUser){
      userInput.value = originalUser;
      return;
    }
    if(newUser !== originalUser) delete txMasterMap[originalUser];
    txMasterMap[newUser] = newKho;
    txMasterSave();
    renderMasterTable();
    txRecomputeFromRecords();
  });

  tbody.addEventListener('click', (e) => {
    const btn = e.target.closest('.tx-master-del');
    if(!btn) return;
    const tr = btn.closest('tr');
    const user = tr.dataset.user;
    if(!confirm(`Xoá user "${user}" khỏi bảng Master?`)) return;
    delete txMasterMap[user];
    txMasterSave();
    renderMasterTable();
    txRecomputeFromRecords();
  });

  if(searchEl) searchEl.addEventListener('input', renderMasterTable);

  if(addBtn){
    addBtn.addEventListener('click', () => {
      txSetMasterCollapsed(false);
      let key = 'User mới';
      let n = 1;
      while(Object.prototype.hasOwnProperty.call(txMasterMap, key)) key = `User mới ${++n}`;
      txMasterMap[key] = '';
      txMasterSave();
      renderMasterTable();
      requestAnimationFrame(() => {
        const tr = tbody.querySelector(`tr[data-user="${CSS.escape(key)}"]`);
        const inp = tr ? tr.querySelector('.tx-master-user') : null;
        if(inp){ inp.focus(); inp.select(); }
      });
    });
  }

  if(resetBtn){
    resetBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if(!confirm('Khôi phục bảng Master về danh sách mặc định? Các chỉnh sửa hiện tại sẽ mất.')) return;
      txMasterMap = { ...TX_MASTER_DEFAULT };
      txMasterSave();
      renderMasterTable();
      txRecomputeFromRecords();
    });
  }
}

function txMasterHydrate(){
  txMasterMap = txMasterLoad();
  renderMasterTable();
  txSetMasterCollapsed(txLoadMasterCollapsed());
}
txMasterHydrate();
txMasterWire();
FileVault.registerReloader(txMasterHydrate);

function txReadFileAsRows(file){
  return new Promise((resolve, reject) => {
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    const isDelimited = ['csv','tsv','txt'].includes(ext);
    const r = new FileReader();
    r.onload = (ev) => {
      try{
        if(isDelimited){
          const text = decodeTextBuffer(ev.target.result);
          const delim = ext === 'tsv' ? '\t' : (ext === 'csv' ? ',' : guessDelimiter(text));
          resolve(parseDelimitedText(text, delim));
        } else {
          if(!LIB_XLSX_OK) throw new Error('Thư viện đọc Excel (SheetJS) chưa tải được — cần Internet. Hãy lưu file dạng .csv/.tsv rồi tải lên.');
          const wb = XLSX.read(ev.target.result, {type:'array', cellDates:false});
          resolve(txExtractSheetRows(wb).rows);
        }
      }catch(err){ reject(err); }
    };
    r.onerror = () => reject(new Error('Không đọc được file.'));
    r.readAsArrayBuffer(file);
  });
}

function txSaveToStorage(){
  if(!STORAGE_OK || !txState) return;
  try{
    LS.setItem(TX_STORAGE_KEY, JSON.stringify(txState));
  }catch(err){
    console.warn('Không lưu được dữ liệu Transaction:', err);
  }
}
function txLoadFromStorage(){
  if(!STORAGE_OK) return null;
  try{
    const raw = LS.getItem(TX_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  }catch(err){ return null; }
}
function txClearStorage(){
  if(!STORAGE_OK) return;
  LS.removeItem(TX_STORAGE_KEY);
}

function txSortRows(rows, key, dir){
  const numeric = key === 'total' || key === 'qty' || key === 'chuyen' || key === 'contCount';
  const valueOf = r => key === 'chuyen' ? (r.chuyenNo || 0) : (r[key] || 0);
  return [...rows].sort((a,b) => {
    if(numeric) return (valueOf(a) - valueOf(b)) * dir;
    return String(a[key]||'').localeCompare(String(b[key]||'')) * dir;
  });
}

function txFilterRows(rows, query){
  if(!query) return rows;
  const q = removeDiacritics(query.toLowerCase().trim());
  return rows.filter(r => Object.values(r).some(v => removeDiacritics(String(v||'').toLowerCase()).includes(q)));
}

const TX_TABLE_DEFS = {
  receive: { cols: ['khoXuat','transType','item','locator','user'], tbody:'tx-receive-tbody', tfoot:'tx-receive-tfoot', empty:'tx-receive-empty', search:'tx-receive-search', summary:'tx-receive-summary', table:'tx-receive-table', label:'dòng Receive', clearBtn:'tx-receive-clear-filters' },
  transfer: { cols: ['khoXuat','menuName','item','locatorXuat','locatorDen','user','qty','chuyen'], tbody:'tx-transfer-tbody', tfoot:'tx-transfer-tfoot', empty:'tx-transfer-empty', search:'tx-transfer-search', summary:'tx-transfer-summary', table:'tx-transfer-table', label:'nhóm Transfer', clearBtn:'tx-transfer-clear-filters' },
  picking: { cols: ['khoXuat','locatorDen','item','user','reference','contCount'], tbody:'tx-picking-tbody', tfoot:'tx-picking-tfoot', empty:'tx-picking-empty', search:'tx-picking-search', summary:'tx-picking-summary', table:'tx-picking-table', label:'nhóm Picking', clearBtn:'tx-picking-clear-filters' }
};

const TX_DEFAULT_KHO_FILTER = '3B';
const TX_TRANSFER_DEFAULT_MENU = ['ITN Receiving', 'ITN Transfer'];
function txDefaultColFilters(){
  return { khoXuat: new Set([TX_DEFAULT_KHO_FILTER]) };
}
function txApplyDefaultFilters(){
  txColFilters.receive = txDefaultColFilters();
  txColFilters.picking = txDefaultColFilters();
  const transferFilters = txDefaultColFilters();
  transferFilters.menuName = new Set(TX_TRANSFER_DEFAULT_MENU);
  txColFilters.transfer = transferFilters;
}
const txColFilters = { receive: txDefaultColFilters(), transfer: txDefaultColFilters(), picking: txDefaultColFilters() }; // { kind: { colKey: Set(labels) | undefined } }

function txColValueLabel(v){
  return (v===undefined || v===null || v==='') ? '(trống)' : String(v);
}

function txApplyFilters(kind, rows, query){
  let out = rows;
  const filters = txColFilters[kind] || {};
  const activeCols = Object.keys(filters).filter(c => filters[c] && filters[c].size);
  if(activeCols.length){
    out = out.filter(r => activeCols.every(c => filters[c].has(txColValueLabel(r[c]))));
  }
  if(query){
    const q = removeDiacritics(query.toLowerCase().trim());
    out = out.filter(r => Object.values(r).some(v => removeDiacritics(String(v||'').toLowerCase()).includes(q)));
  }
  return out;
}

function txAnyColumnFilterActive(kind){
  const filters = txColFilters[kind] || {};
  return Object.keys(filters).some(c => filters[c] && filters[c].size);
}

function renderTxTable(kind){
  if(!txState) return;
  const def = TX_TABLE_DEFS[kind];
  const tbody = document.getElementById(def.tbody);
  const tfoot = document.getElementById(def.tfoot);
  const emptyEl = document.getElementById(def.empty);
  const summaryEl = document.getElementById(def.summary);
  if(!tbody) return;

  const searchEl = document.getElementById(def.search);
  const query = searchEl ? searchEl.value : '';
  let rows = txApplyFilters(kind, txState[kind] || [], query);
  const sort = txSort[kind];
  rows = txSortRows(rows, sort.key, sort.dir);

  txUpdateFilterIcons(kind);
  const clearBtn = document.getElementById(def.clearBtn);
  if(clearBtn) clearBtn.style.display = txAnyColumnFilterActive(kind) ? 'inline' : 'none';

  if(!rows.length){
    tbody.innerHTML = '';
    if(tfoot) tfoot.innerHTML = '';
    if(emptyEl) emptyEl.style.display = 'block';
    if(summaryEl) summaryEl.textContent = (txState[kind]||[]).length ? 'Không có dòng nào khớp bộ lọc / tìm kiếm' : 'Chưa có dữ liệu';
    renderTxChart();
    return;
  }
  if(emptyEl) emptyEl.style.display = 'none';

  const grandTotal = rows.reduce((s,r)=>s+r.total,0);
  const grandQty = rows.reduce((s,r)=>s+(r.qty||0),0);
  // Số lượng cont TỔNG phải là số CR KHÁC NHAU trên toàn bộ các dòng đang hiển thị — không phải
  // cộng dồn số cont của từng dòng (1 container thường xuất hiện ở NHIỀU dòng khác nhau, cộng dồn
  // sẽ đếm trùng rất nhiều lần).
  const grandContSet = new Set();
  rows.forEach(r => (r.contCodes || []).forEach(c => grandContSet.add(c)));
  const grandContCount = grandContSet.size;
  tbody.innerHTML = rows.map(r => {
    const tds = def.cols.map(c => {
      if(c === 'qty') return `<td class="num">${(r.qty===undefined||r.qty===null) ? '—' : fmt(r.qty)}</td>`;
      if(c === 'contCount') return `<td class="num">${(r.contCount===undefined||r.contCount===null) ? '—' : fmt(r.contCount)}</td>`;
      const v = r[c];
      return `<td>${(v===''||v===undefined||v===null) ? '—' : escHtml(String(v))}</td>`;
    }).join('');
    // Cột tick (✓) — CHỈ riêng bảng Transfer, để người dùng tự đánh dấu đã kiểm tra dòng nào, giữ
    // lại qua lần tải file Transaction mới (khoá theo "hình dạng" chuyến hàng, xem txTransferRowKey()).
    // Đã tick -> tô màu nguyên dòng (class tx-row-checked, xem CSS) để dễ phân biệt.
    let checkTd = '', rowClass = '';
    if(kind === 'transfer'){
      const isChecked = !!txTransferChecked[txTransferRowKey(r)];
      rowClass = isChecked ? ' class="tx-row-checked"' : '';
      checkTd = `<td style="text-align:center"><input type="checkbox" class="tx-transfer-check" data-tx-check-key="${escAttr(txTransferRowKey(r))}" ${isChecked ? 'checked' : ''}></td>`;
    }
    return `<tr${rowClass}>${tds}<td class="num tx-total-col">${fmt(r.total)}</td>${checkTd}</tr>`;
  }).join('');
  if(tfoot){
    const footTds = def.cols.slice(1).map(c => {
      if(c === 'qty') return `<td class="num">${fmt(grandQty)}</td>`;
      if(c === 'contCount') return `<td class="num">${fmt(grandContCount)}</td>`;
      return '<td></td>';
    }).join('');
    const footCheckTd = kind === 'transfer' ? '<td></td>' : '';
    tfoot.innerHTML = `<tr style="font-weight:700; border-top:2px solid var(--line);"><td>Grand Total</td>${footTds}<td class="num tx-total-col">${fmt(grandTotal)}</td>${footCheckTd}</tr>`;
  }
  if(summaryEl) summaryEl.textContent = `${rows.length} ${def.label} · Tổng: ${fmt(grandTotal)}`;
  renderTxChart();
}

function txGrandTotalFor(kind){
  if(!txState) return { total: 0, rowsCount: 0 };
  const def = TX_TABLE_DEFS[kind];
  const searchEl = document.getElementById(def.search);
  const query = searchEl ? searchEl.value : '';
  const rows = txApplyFilters(kind, txState[kind] || [], query);
  return { total: rows.reduce((s,r)=>s+r.total,0), rowsCount: rows.length };
}

const TX_CHART_ITEMS = [
  { key:'receive', label:'Receive', color:'var(--teal)' },
  { key:'transfer', label:'Transfer', color:'var(--blue)' },
  { key:'picking', label:'Picking', color:'var(--violet)' }
];

function renderTxChart(){
  const wrap = document.getElementById('tx-chart-body');
  if(!wrap) return;
  if(!txState){
    wrap.innerHTML = '<div class="kho-empty" style="padding:24px 0;">Chưa có dữ liệu — hãy tải file Transaction ở trên.</div>';
    return;
  }
  const items = TX_CHART_ITEMS.map(it => ({ ...it, ...txGrandTotalFor(it.key) }));
  const maxVal = Math.max(1, ...items.map(i => i.total));
  wrap.innerHTML = `<div class="tx-chart-wrap">${items.map(it => {
    const pct = it.total > 0 ? Math.max(3, Math.round((it.total / maxVal) * 100)) : 1;
    return `<div class="tx-chart-bar-col">
      <div class="tx-chart-bar-value" style="color:${it.color}">${fmt(it.total)}</div>
      <div class="tx-chart-bar" style="height:${pct}%; background:${it.color};"></div>
      <div class="tx-chart-bar-label">${it.label}<div class="tx-chart-bar-sub">${fmt(it.rowsCount)} dòng đang hiển thị</div></div>
    </div>`;
  }).join('')}</div>`;
}

function escHtml(s){
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function renderTxKpiStrip(){
  const el = document.getElementById('transaction-kpi-strip');
  if(!el) return;
  if(!txState){ el.innerHTML = ''; return; }
  const k = txState.kpi;
  el.innerHTML = `
    <div class="kpi"><div class="label">TỔNG DÒNG</div><div class="value">${fmt(k.nRows)}</div><div class="foot">dòng giao dịch trong file</div></div>
    <div class="kpi accent"><div class="label">RECEIVE</div><div class="value">${fmt(k.countReceive)}</div><div class="foot">${fmt(k.receiveGroups)} dòng thống kê</div></div>
    <div class="kpi good"><div class="label">TRANSFER</div><div class="value">${fmt(k.transferTotal)}</div><div class="foot">${fmt(k.transferGroups)} dòng thống kê / ${fmt(k.countTransfer)} bản ghi (mọi Menu Name, trừ Pick Order)</div></div>
    <div class="kpi"><div class="label">PICKING</div><div class="value">${fmt(k.pickingTotal)}</div><div class="foot">${fmt(k.pickingGroups)} dòng thống kê / ${fmt(k.countPicking)} bản ghi Pick Order</div></div>
  `;
}

function renderTransactionPage(){
  renderTxKpiStrip();
  renderTxTable('receive');
  renderTxTable('transfer');
  renderTxTable('picking');
  renderXeTrungChuyenTable('itnTransferGroups', 'tx-xtc-transfer');
  renderXeTrungChuyenTable('itnReceivingGroups', 'tx-xtc-receiving');
  renderTxChart();
}

// Tick/bỏ tick ở bảng "Chuyển pallet (Transfer)" — chỉ tick, không có tác dụng nghiệp vụ nào khác
// ngoài tự đánh dấu đã kiểm tra. Lưu ngay (cục bộ + tự đẩy lên Cloud) để giữ được qua lần tải file
// Transaction mới, đổi thiết bị/tải lại trang.
document.addEventListener('change', (e) => {
  const cb = e.target.closest('.tx-transfer-check');
  if(!cb) return;
  const key = cb.dataset.txCheckKey;
  if(!key) return;
  if(cb.checked) txTransferChecked[key] = true;
  else delete txTransferChecked[key];
  const tr = cb.closest('tr');
  if(tr) tr.classList.toggle('tx-row-checked', cb.checked);
  saveStateToStorage();
  scheduleAutoSaveToCloud('txcheck', [STORAGE_KEY_TX_TRANSFER_CHECKED], 'Tick "Chuyển pallet (Transfer)"');
});

// "Xe Trung Chuyển" — 2 bảng song song: bên trái ITN Transfer (Chuyển đi), bên phải ITN Receiving
// (Nhận). Mỗi bảng gộp nhóm theo Item + Locator xuất + Locator đến + Chuyến (cùng Reference).
function renderXeTrungChuyenTable(stateKey, prefix){
  const tbody = document.getElementById(`${prefix}-tbody`);
  const emptyEl = document.getElementById(`${prefix}-empty`);
  const summaryEl = document.getElementById(`${prefix}-summary`);
  const searchEl = document.getElementById(`${prefix}-search`);
  if(!tbody) return;
  const allRows = txState ? (txState[stateKey] || []) : null;
  if(!allRows){
    tbody.innerHTML = '';
    if(emptyEl) emptyEl.style.display = 'block';
    if(summaryEl) summaryEl.textContent = 'Chưa có dữ liệu';
    return;
  }
  const query = searchEl ? searchEl.value : '';
  let rows = allRows;
  if(query){
    const q = removeDiacritics(query.toLowerCase().trim());
    rows = rows.filter(r => Object.values(r).some(v => removeDiacritics(String(v===null||v===undefined?'':v).toLowerCase()).includes(q)));
  }
  if(!rows.length){
    tbody.innerHTML = '';
    if(emptyEl) emptyEl.style.display = 'block';
    if(summaryEl) summaryEl.textContent = allRows.length ? 'Không có dòng nào khớp tìm kiếm' : 'Chưa có dữ liệu';
    return;
  }
  if(emptyEl) emptyEl.style.display = 'none';
  const grandQty = rows.reduce((s,r)=>s+r.qty, 0);
  const grandTotal = rows.reduce((s,r)=>s+r.total, 0);
  tbody.innerHTML = rows.map(r => `<tr>
      <td>${escHtml(r.item)}</td>
      <td>${escHtml(r.locator)}</td>
      <td>${escHtml(r.chuyen)}</td>
      <td>${escHtml(r.user)}</td>
      <td class="num">${fmt(r.qty)}</td>
      <td class="num tx-total-col">${fmt(r.total)}</td>
    </tr>`).join('');
  const tfoot = document.getElementById(`${prefix}-tfoot`);
  if(tfoot){
    tfoot.innerHTML = `<tr style="font-weight:700; border-top:2px solid var(--line);"><td>Grand Total</td><td></td><td></td><td></td><td class="num">${fmt(grandQty)}</td><td class="num tx-total-col">${fmt(grandTotal)}</td></tr>`;
  }
  if(summaryEl) summaryEl.textContent = `${fmt(rows.length)} dòng · ${fmt(new Set(rows.map(r=>r.reference)).size)} Chuyến · Tổng: ${fmt(grandTotal)}`;
}
['tx-xtc-transfer-search','tx-xtc-receiving-search'].forEach(id => {
  const el = document.getElementById(id);
  if(el) el.addEventListener('input', () => {
    renderXeTrungChuyenTable('itnTransferGroups', 'tx-xtc-transfer');
    renderXeTrungChuyenTable('itnReceivingGroups', 'tx-xtc-receiving');
  });
});

// Sắp xếp khi click vào tiêu đề cột + gắn nút lọc cột (filter theo giá trị, kiểu Excel)
Object.keys(TX_TABLE_DEFS).forEach(kind => {
  const def = TX_TABLE_DEFS[kind];
  const tableEl = document.getElementById(def.table);
  if(!tableEl) return;
  tableEl.querySelectorAll('thead th[data-key]').forEach(th => {
    const key = th.dataset.key;
    th.style.cursor = 'pointer';
    th.addEventListener('click', (e) => {
      if(e.target.closest('.th-filter-btn')) return;
      const sort = txSort[kind];
      if(sort.key === key) sort.dir *= -1;
      else { sort.key = key; sort.dir = key === 'total' ? -1 : 1; }
      renderTxTable(kind);
    });
    // "reference" không gắn nút lọc: đây là danh sách NHIỀU mã CR gộp lại (mỗi dòng 1 tổ hợp khác
    // nhau), lọc theo giá trị y hệt kiểu Excel sẽ không có ý nghĩa — cứ gõ mã CR vào ô tìm kiếm phía
    // trên là tìm được (search chung đã tự quét qua field này).
    if(key !== 'total' && key !== 'qty' && key !== 'chuyen' && key !== 'contCount' && key !== 'reference'){
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'th-filter-btn';
      btn.dataset.kind = kind;
      btn.dataset.col = key;
      btn.title = 'Lọc theo giá trị';
      btn.style.cssText = 'margin-left:6px; border:none; background:none; cursor:pointer; color:inherit; opacity:0.55; vertical-align:middle; padding:2px;';
      btn.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="3 4 21 4 14 12.5 14 19 10 21 10 12.5 3 4"></polygon></svg>';
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        txToggleColumnFilterDropdown(kind, key, btn);
      });
      th.appendChild(btn);
    }
  });
  const searchEl = document.getElementById(def.search);
  if(searchEl) searchEl.addEventListener('input', () => renderTxTable(kind));
  const clearBtn = document.getElementById(def.clearBtn);
  if(clearBtn){
    clearBtn.style.display = 'none';
    clearBtn.addEventListener('click', () => {
      txColFilters[kind] = {};
      renderTxTable(kind);
    });
  }
});

let txActiveFilterDropdown = null; // {kind, col, el}
function txCloseFilterDropdown(){
  if(txActiveFilterDropdown){ txActiveFilterDropdown.el.remove(); txActiveFilterDropdown = null; }
  document.removeEventListener('mousedown', txFilterDropdownOutsideHandler, true);
}
function txFilterDropdownOutsideHandler(e){
  if(txActiveFilterDropdown && !txActiveFilterDropdown.el.contains(e.target)) txCloseFilterDropdown();
}
function txGetColumnValues(kind, colKey){
  const rows = txState ? (txState[kind] || []) : [];
  const set = new Set();
  rows.forEach(r => set.add(txColValueLabel(r[colKey])));
  return Array.from(set).sort((a,b) => a.localeCompare(b, 'vi'));
}
function txUpdateFilterIcons(kind){
  const def = TX_TABLE_DEFS[kind];
  const tableEl = document.getElementById(def.table);
  if(!tableEl) return;
  tableEl.querySelectorAll('.th-filter-btn').forEach(btn => {
    const col = btn.dataset.col;
    const active = !!(txColFilters[kind] && txColFilters[kind][col] && txColFilters[kind][col].size);
    btn.style.opacity = active ? '1' : '0.55';
    btn.style.color = active ? 'var(--blue)' : 'inherit';
  });
}
function txToggleColumnFilterDropdown(kind, col, btn){
  if(txActiveFilterDropdown && txActiveFilterDropdown.kind === kind && txActiveFilterDropdown.col === col){
    txCloseFilterDropdown();
    return;
  }
  txCloseFilterDropdown();
  if(!txState){ return; }
  const values = txGetColumnValues(kind, col);
  const currentSet = txColFilters[kind][col];
  const rect = btn.getBoundingClientRect();
  const panel = document.createElement('div');
  panel.className = 'tx-filter-dropdown';
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - 260));
  panel.style.cssText = `position:fixed; top:${rect.bottom+4}px; left:${left}px; width:240px; max-height:340px; overflow:auto; background:#fff; border:1px solid var(--line); border-radius:10px; box-shadow:0 12px 32px rgba(0,0,0,0.18); z-index:9999; padding:10px; font-family:var(--mono);`;

  const isAllSelected = !currentSet;
  const checklistHtml = values.map(v => {
    const checked = isAllSelected || currentSet.has(v);
    return `<label style="display:flex; align-items:center; gap:8px; padding:5px 4px; font-size:12.5px; cursor:pointer; border-radius:6px;">
      <input type="checkbox" class="tx-filter-chk" value="${escAttr(v)}" ${checked ? 'checked' : ''}>
      <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escHtml(v)}</span>
    </label>`;
  }).join('') || '<div style="font-size:12px; color:var(--muted); padding:6px 2px;">Không có giá trị</div>';

  panel.innerHTML = `
    <input type="text" class="tx-filter-search-inner" placeholder="Tìm giá trị…" style="width:100%; box-sizing:border-box; border:1px solid var(--line); border-radius:6px; padding:7px 9px; font-size:12.5px; margin-bottom:8px; outline:none;">
    <div style="display:flex; gap:12px; margin-bottom:6px;">
      <button type="button" class="tx-filter-selall" style="font-size:11.5px; border:none; background:none; color:var(--blue); cursor:pointer; padding:0;">Chọn tất cả</button>
      <button type="button" class="tx-filter-clrall" style="font-size:11.5px; border:none; background:none; color:var(--blue); cursor:pointer; padding:0;">Bỏ chọn</button>
    </div>
    <div class="tx-filter-list">${checklistHtml}</div>
    <div style="display:flex; gap:8px; margin-top:10px; border-top:1px solid var(--line); padding-top:8px;">
      <button type="button" class="tx-filter-apply btn-update" style="flex:1; padding:6px 8px; font-size:12px; justify-content:center;">Áp dụng</button>
      <button type="button" class="tx-filter-reset btn-update btn-danger" style="flex:1; padding:6px 8px; font-size:12px; justify-content:center;">Xoá lọc</button>
    </div>
  `;
  document.body.appendChild(panel);
  txActiveFilterDropdown = { kind, col, el: panel };
  setTimeout(() => document.addEventListener('mousedown', txFilterDropdownOutsideHandler, true), 0);

  const searchInner = panel.querySelector('.tx-filter-search-inner');
  searchInner.focus();
  searchInner.addEventListener('input', () => {
    const q = removeDiacritics(searchInner.value.toLowerCase().trim());
    panel.querySelectorAll('.tx-filter-list label').forEach(lbl => {
      const text = removeDiacritics(lbl.textContent.toLowerCase());
      lbl.style.display = text.includes(q) ? 'flex' : 'none';
    });
  });
  panel.querySelector('.tx-filter-selall').addEventListener('click', () => {
    panel.querySelectorAll('.tx-filter-list label').forEach(lbl => {
      if(lbl.style.display !== 'none'){ const c = lbl.querySelector('.tx-filter-chk'); if(c) c.checked = true; }
    });
  });
  panel.querySelector('.tx-filter-clrall').addEventListener('click', () => {
    panel.querySelectorAll('.tx-filter-list label').forEach(lbl => {
      if(lbl.style.display !== 'none'){ const c = lbl.querySelector('.tx-filter-chk'); if(c) c.checked = false; }
    });
  });
  panel.querySelector('.tx-filter-apply').addEventListener('click', () => {
    const checked = Array.from(panel.querySelectorAll('.tx-filter-chk')).filter(c => c.checked).map(c => c.value);
    if(checked.length === 0 || checked.length === values.length){
      delete txColFilters[kind][col];
    } else {
      txColFilters[kind][col] = new Set(checked);
    }
    txCloseFilterDropdown();
    renderTxTable(kind);
  });
  panel.querySelector('.tx-filter-reset').addEventListener('click', () => {
    delete txColFilters[kind][col];
    txCloseFilterDropdown();
    renderTxTable(kind);
  });
}

const txBtnUpdate = document.getElementById('btn-update-transaction');
const txFileInput = document.getElementById('transaction-file-input');
const txStatusEl = document.getElementById('transaction-upload-status');
const txOverlay = document.getElementById('loading-overlay');
const txLoadingMsg = document.getElementById('loading-msg');

if(txBtnUpdate && txFileInput) txBtnUpdate.addEventListener('click', () => txFileInput.click());

if(txFileInput){
  txFileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if(!file) return;
    if(txOverlay) txOverlay.classList.add('show');
    if(txLoadingMsg) txLoadingMsg.textContent = `Đang đọc "${file.name}"…`;
    if(txStatusEl){ txStatusEl.className = 'upload-status'; txStatusEl.textContent = 'Đang xử lý…'; }
    try{
      const rows = await txReadFileAsRows(file);
      const records = txParseTransactionRecords(rows);
      const stats = txBuildStatsFromRecords(records, txMasterMap);
      txState = {
        records,
        receive: stats.receive, transfer: stats.transfer, picking: stats.picking,
        itnTransferGroups: stats.itnTransferGroups, itnReceivingGroups: stats.itnReceivingGroups, kpi: stats.kpi,
        fileName: file.name, updatedAtText: `Cập nhật lúc ${fmtDateTime(new Date())}`
      };
      txApplyDefaultFilters();
      renderTransactionPage();
      txSaveToStorage();
      const tEl = document.getElementById('transaction-updated-at');
      if(tEl) tEl.textContent = txState.updatedAtText;
      const fEl = document.getElementById('transaction-file-line');
      if(fEl){ fEl.textContent = `File: ${file.name}`; fEl.title = file.name; }
      if(txStatusEl){ txStatusEl.className = 'upload-status ok'; txStatusEl.textContent = `✓ Đã cập nhật từ "${file.name}" (${fmt(stats.kpi.nRows)} dòng)`; }
    }catch(err){
      console.error('Lỗi khi xử lý file transaction:', err);
      if(txStatusEl){ txStatusEl.className = 'upload-status err'; txStatusEl.textContent = `✗ Lỗi: ${err.message}`; }
    }finally{
      if(txOverlay) txOverlay.classList.remove('show');
      txFileInput.value = '';
    }
  });
}

// Dòng hiển thị THƯỜNG TRỰC "đã cập nhật Ship lúc mấy giờ, file nào" cạnh nút "🚚 Cập nhật Transaction
// (Ship)" — trước đây chỉ có dòng thông báo tạm #cont-ship-status (biến mất/đổi nội dung ngay khi có
// thao tác khác), không có chỗ nào cho biết lần cập nhật GẦN NHẤT là lúc nào khi quay lại xem sau —
// gọi hàm này ở MỌI nơi contShipData được gán (tải file mới, khôi phục đã lưu, đồng bộ Cloud).
function renderContShipUpdatedLine(){
  const el = document.getElementById('cont-ship-updated-line');
  if(!el) return;
  if(!contShipData){ el.textContent = 'Chưa cập nhật Ship'; return; }
  el.textContent = `${contShipData.updatedAtText || 'Đã cập nhật'}${contShipData.fileName ? ' · ' + contShipData.fileName : ''}`;
  el.title = contShipData.fileName || '';
}

// Nút "🚚 Cập nhật Transaction (Ship)" ở panel Picking Status — tái dùng ĐÚNG cơ chế đọc file của
// trang Transaction (txReadFileAsRows/txParseTransactionRecords), chỉ lọc riêng Transaction Type =
// Ship để phủ trạng thái Đang Load/Đã Load Xong lên bảng, không tạo state Transaction đầy đủ.
const contShipFileInput = document.getElementById('cont-ship-file-input');
const btnContShipUpload = document.getElementById('btn-cont-ship-upload');
if(btnContShipUpload && contShipFileInput) btnContShipUpload.addEventListener('click', () => contShipFileInput.click());
if(contShipFileInput){
  contShipFileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if(!file) return;
    const statusEl = document.getElementById('cont-ship-status');
    const overlay = document.getElementById('loading-overlay');
    const loadingMsg = document.getElementById('loading-msg');
    if(overlay) overlay.classList.add('show');
    if(loadingMsg) loadingMsg.textContent = `Đang đọc "${file.name}"…`;
    if(statusEl){ statusEl.style.display = ''; statusEl.className = 'upload-status'; statusEl.textContent = 'Đang xử lý…'; }
    try{
      const rows = await txReadFileAsRows(file);
      const records = txParseTransactionRecords(rows);
      const { byRef, byRefItem, byRefLocators } = contShipBuildFromRecords(records);
      if(!byRef.size) throw new Error('Không tìm thấy dòng nào có Transaction Type = Ship trong file này.');
      contShipData = { byRef, byRefItem, byRefLocators, fileName: file.name, updatedAtText: `Cập nhật lúc ${fmtDateTime(new Date())}` };
      _localShipDirty = true;
      renderContShipUpdatedLine();
      // Gọi lại renderPlanPanel() (không chỉ renderContainerPickingOverview()) — vì "Tổng hợp 3 Plan"
      // (so Đủ/Thiếu với tồn kho) cũng phụ thuộc container nào đã Pick xong, cần build lại luôn để
      // không báo Thiếu nhầm cho hàng của container vừa được tính Đã Load Xong.
      renderPlanPanel();
      saveStateToStorage();
      // Đẩy ngay lên Cloud để các máy/người khác đang mở dashboard cũng thấy đúng trạng thái Load mới
      // nhất (realtime) — không cần đợi bấm nút "Lưu" ở đầu trang mới đồng bộ.
      scheduleAutoSaveToCloud('contship', [STORAGE_KEY_CONT_SHIP], 'Cập nhật Transaction (Ship)');
      const matchedCount = contShipCountMatchedContainers(byRef);
      if(statusEl){
        statusEl.className = matchedCount ? 'upload-status ok' : 'upload-status err';
        statusEl.textContent = matchedCount
          ? `✓ Đã cập nhật Ship từ "${file.name}" — khớp được ${fmt(matchedCount)}/${fmt(byRef.size)} Reference (CR) với container đang có trong Plan.`
          : `⚠ Đã đọc "${file.name}" (${fmt(byRef.size)} Reference Ship), nhưng KHÔNG khớp được CR nào với các container đang có trong Plan — kiểm tra lại đúng file/đúng đợt Plan chưa.`;
      }
    }catch(err){
      console.error('Lỗi khi đọc file Ship:', err);
      if(statusEl){ statusEl.className = 'upload-status err'; statusEl.textContent = `✗ Lỗi: ${err.message}`; }
    }finally{
      if(overlay) overlay.classList.remove('show');
      contShipFileInput.value = '';
    }
  });
}

const txBtnReset = document.getElementById('btn-reset-transaction');
if(txBtnReset){
  txBtnReset.addEventListener('click', () => {
    if(!txState){ return; }
    const ok = confirm('Xoá dữ liệu Transaction đã lưu trong trình duyệt này?');
    if(!ok) return;
    txState = null;
    txClearStorage();
    txApplyDefaultFilters();
    renderTransactionPage();
    const tEl = document.getElementById('transaction-updated-at');
    if(tEl) tEl.textContent = 'Chưa có dữ liệu';
    const fEl = document.getElementById('transaction-file-line');
    if(fEl){ fEl.textContent = 'File: —'; fEl.title = ''; }
    if(txStatusEl){ txStatusEl.className = 'upload-status'; txStatusEl.textContent = 'Đã xoá — Tải file .tsv / .csv / .xlsx transaction để thống kê'; }
  });
}

// Khôi phục dữ liệu Transaction đã lưu (nếu có) khi mở lại trang
function initTransactionPage(){
  const saved = txLoadFromStorage();
  if(saved){
    txState = saved;
    txApplyDefaultFilters();
    renderTransactionPage();
    const tEl = document.getElementById('transaction-updated-at');
    if(tEl) tEl.textContent = saved.updatedAtText || 'Đã khôi phục';
    const fEl = document.getElementById('transaction-file-line');
    if(fEl && saved.fileName){ fEl.textContent = `File: ${saved.fileName}`; fEl.title = saved.fileName; }
    if(txStatusEl){ txStatusEl.className = 'upload-status ok'; txStatusEl.textContent = '✓ Đã khôi phục dữ liệu Transaction đã lưu trong trình duyệt này'; }
  }
}
initTransactionPage();
FileVault.registerReloader(initTransactionPage);

/* ============================================================
   ============  TAB "SO SÁNH WMS vs ERP"  ============
   ============================================================
   So sánh Item No. + Locator + Số lượng tồn giữa file ERP (cột Item / Locator /
   On-hand Qty) và file WMS (cột Item No. / Locator Name / Onhand Qty), tách
   riêng theo 3 kho: 2B, 3A, 3B (dựa vào locator có chứa mã kho tương ứng).
   Chỉ tải 1 file ERP + 1 file WMS (đã gồm dữ liệu mọi kho), rồi tự lọc ra 3 bộ. */
const CMP_STORAGE_KEY = 'tn5_compare_v1';
const CMP_KHO_CODES = ['2B', '3A', '3B'];
let cmpErpMaps = {}; // { '2B': Map("item||locator"->qty), '3A': Map, '3B': Map }
let cmpWmsMaps = {};
let cmpErpMeta = null; // { fileName, updatedAtText }
let cmpWmsMeta = null;

function cmpReadFileAsRows(file){
  return new Promise((resolve, reject) => {
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    const isDelimited = ['csv','tsv','txt'].includes(ext);
    const r = new FileReader();
    r.onload = (ev) => {
      try{
        if(isDelimited){
          const text = decodeTextBuffer(ev.target.result);
          const delim = ext === 'tsv' ? '\t' : (ext === 'csv' ? ',' : guessDelimiter(text));
          resolve(parseDelimitedText(text, delim));
        } else {
          if(!LIB_XLSX_OK) throw new Error('Thư viện đọc Excel (SheetJS) chưa tải được — cần Internet. Hãy lưu file dạng .csv/.tsv rồi tải lên.');
          const wb = XLSX.read(ev.target.result, {type:'array', cellDates:false});
          const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], {header:1, raw:true, defval:null});
          resolve(rows);
        }
      }catch(err){ reject(err); }
    };
    r.onerror = () => reject(new Error('Không đọc được file.'));
    r.readAsArrayBuffer(file);
  });
}

// Đọc 1 file, trả về 3 Map (1 map / kho) cùng lúc — mỗi dòng dữ liệu được xếp vào map
// của kho tương ứng nếu locator có chứa mã kho đó (VD: "2B-FG-ITN" -> Kho 2B).
function cmpBuildMaps(rows, itemCands, locatorCands, qtyCands, missingMsg){
  if(!rows.length) throw new Error('File không có dữ liệu.');
  const headers = rows[0];
  const colItem = findCol(headers, itemCands);
  const colLocator = findCol(headers, locatorCands);
  const colQty = findCol(headers, qtyCands);
  if(colItem === -1 || colLocator === -1 || colQty === -1) throw new Error(missingMsg);
  const maps = {};
  CMP_KHO_CODES.forEach(c => maps[c] = new Map());
  for(let i=1;i<rows.length;i++){
    const r = rows[i];
    if(!r) continue;
    const locator = txNorm(r[colLocator]);
    if(!locator) continue;
    const locUp = locator.toUpperCase();
    const item = txItemText(r[colItem]);
    if(!item) continue;
    const qty = parseFloat(r[colQty]) || 0;
    const key = item + '||' + locator;
    CMP_KHO_CODES.forEach(code => {
      if(!locUp.includes(code)) return;
      const map = maps[code];
      map.set(key, (map.get(key) || 0) + qty);
    });
  }
  return maps;
}
function cmpParseErpRows(rows){
  return cmpBuildMaps(rows, ['item'], ['locator'], ['on-hand qty','onhand qty','on hand qty'],
    'File ERP thiếu cột bắt buộc (Item / Locator / On-hand Qty).');
}
function cmpParseWmsRows(rows){
  return cmpBuildMaps(rows, ['item no.','item no','item number'], ['locator name'], ['onhand qty','on-hand qty','on hand qty'],
    'File WMS thiếu cột bắt buộc (Item No. / Locator Name / Onhand Qty).');
}

function cmpSaveToStorage(){
  if(!STORAGE_OK) return;
  try{
    const erpObj = {}, wmsObj = {};
    CMP_KHO_CODES.forEach(c => {
      erpObj[c] = cmpErpMaps[c] ? Array.from(cmpErpMaps[c].entries()) : null;
      wmsObj[c] = cmpWmsMaps[c] ? Array.from(cmpWmsMaps[c].entries()) : null;
    });
    LS.setItem(CMP_STORAGE_KEY, JSON.stringify({
      erp: erpObj, wms: wmsObj,
      erpMeta: cmpErpMeta, wmsMeta: cmpWmsMeta
    }));
  }catch(err){ console.warn('Không lưu được dữ liệu So sánh:', err); }
}
function cmpLoadFromStorage(){
  if(!STORAGE_OK) return null;
  try{
    const raw = LS.getItem(CMP_STORAGE_KEY);
    if(!raw) return null;
    const obj = JSON.parse(raw);
    const erp = {}, wms = {};
    if(Array.isArray(obj.erp) || Array.isArray(obj.wms)){
      // Dữ liệu cũ (chỉ có Kho 3B, trước khi mở rộng sang 2B/3A) -> chuyển sang định dạng mới
      CMP_KHO_CODES.forEach(c => { erp[c] = null; wms[c] = null; });
      erp['3B'] = obj.erp ? new Map(obj.erp) : null;
      wms['3B'] = obj.wms ? new Map(obj.wms) : null;
    } else {
      CMP_KHO_CODES.forEach(c => {
        erp[c] = obj.erp && obj.erp[c] ? new Map(obj.erp[c]) : null;
        wms[c] = obj.wms && obj.wms[c] ? new Map(obj.wms[c]) : null;
      });
    }
    return { erp, wms, erpMeta: obj.erpMeta || null, wmsMeta: obj.wmsMeta || null };
  }catch(err){ return null; }
}
function cmpClearStorage(){ if(STORAGE_OK) LS.removeItem(CMP_STORAGE_KEY); }

function cmpSplitKey(key){
  const idx = key.indexOf('||');
  return { item: key.slice(0, idx), locator: key.slice(idx + 2) };
}

function renderCompareKpi(code){
  const el = document.getElementById('cmp-kpi-strip-' + code);
  const headEl = document.getElementById('cmp-head-summary-' + code);
  const erp = cmpErpMaps[code], wms = cmpWmsMaps[code];
  if(!erp && !wms){
    if(el) el.innerHTML = '';
    if(headEl) headEl.textContent = 'Chưa có dữ liệu';
    return;
  }
  const erpM = erp || new Map();
  const wmsM = wms || new Map();
  const allKeys = new Set([...erpM.keys(), ...wmsM.keys()]);
  let matchCount = 0, mismatchCount = 0, onlyErp = 0, onlyWms = 0;
  allKeys.forEach(key => {
    const hasErp = erpM.has(key), hasWms = wmsM.has(key);
    const eq = hasErp ? erpM.get(key) : 0, wq = hasWms ? wmsM.get(key) : 0;
    if(hasErp && hasWms) (eq === wq ? matchCount++ : mismatchCount++);
    else if(hasErp) onlyErp++;
    else onlyWms++;
  });
  if(el) el.innerHTML = `
    <div class="kpi"><div class="label">TỔNG DÒNG SO SÁNH</div><div class="value">${fmt(allKeys.size)}</div><div class="foot">Item + Locator "${code}" duy nhất</div></div>
    <div class="kpi good"><div class="label">KHỚP SỐ LƯỢNG</div><div class="value">${fmt(matchCount)}</div><div class="foot">ERP = WMS</div></div>
    <div class="kpi"><div class="label">LỆCH SỐ LƯỢNG</div><div class="value">${fmt(mismatchCount)}</div><div class="foot">ERP ≠ WMS</div></div>
    <div class="kpi accent"><div class="label">CHỈ 1 BÊN CÓ</div><div class="value">${fmt(onlyErp + onlyWms)}</div><div class="foot">${fmt(onlyErp)} chỉ ở ERP · ${fmt(onlyWms)} chỉ ở WMS</div></div>
  `;
  if(headEl) headEl.innerHTML = `
    <span><b>${fmt(allKeys.size)}</b> dòng</span>
    <span class="good"><b>${fmt(matchCount)}</b> khớp</span>
    <span class="${mismatchCount ? 'bad' : ''}"><b>${fmt(mismatchCount)}</b> lệch</span>
    <span class="${(onlyErp+onlyWms) ? 'bad' : ''}"><b>${fmt(onlyErp + onlyWms)}</b> chỉ 1 bên</span>
  `;
}

function renderCompareTables(code){
  const erpTbody = document.getElementById('cmp-erp-tbody-' + code);
  const wmsTbody = document.getElementById('cmp-wms-tbody-' + code);
  const erpEmpty = document.getElementById('cmp-erp-empty-' + code);
  const wmsEmpty = document.getElementById('cmp-wms-empty-' + code);
  const summaryEl = document.getElementById('cmp-summary-' + code);
  if(!erpTbody || !wmsTbody) return;

  renderCompareKpi(code);

  const erp = cmpErpMaps[code], wms = cmpWmsMaps[code];
  if(!erp && !wms){
    erpTbody.innerHTML = ''; wmsTbody.innerHTML = '';
    if(erpEmpty) erpEmpty.style.display = 'block';
    if(wmsEmpty) wmsEmpty.style.display = 'block';
    if(summaryEl) summaryEl.textContent = 'Chưa có dữ liệu';
    return;
  }

  const erpM = erp || new Map();
  const wmsM = wms || new Map();
  const searchEl = document.getElementById('cmp-search-' + code);
  const query = searchEl ? removeDiacritics(searchEl.value.toLowerCase().trim()) : '';

  let keys = [...new Set([...erpM.keys(), ...wmsM.keys()])];
  if(query) keys = keys.filter(k => removeDiacritics(k.toLowerCase()).includes(query));

  // Tính trạng thái từng dòng trước để sắp: lệch / chỉ 1 bên có lên đầu, khớp xuống dưới,
  // trong mỗi nhóm vẫn sắp theo thứ tự chữ cái như cũ.
  const STATUS_PRIORITY = { mismatch: 0, onlyErp: 0, onlyWms: 0, match: 1 };
  const rowsInfo = keys.map(key => {
    const hasErp = erpM.has(key), hasWms = wmsM.has(key);
    const eq = hasErp ? erpM.get(key) : null, wq = hasWms ? wmsM.get(key) : null;
    let status;
    if(hasErp && hasWms) status = (eq === wq) ? 'match' : 'mismatch';
    else if(hasErp) status = 'onlyErp';
    else status = 'onlyWms';
    return { key, status, eq, wq };
  });
  rowsInfo.sort((a, b) => {
    const p = STATUS_PRIORITY[a.status] - STATUS_PRIORITY[b.status];
    if(p !== 0) return p;
    return a.key.localeCompare(b.key, 'vi');
  });

  if(!rowsInfo.length){
    erpTbody.innerHTML = ''; wmsTbody.innerHTML = '';
    if(erpEmpty){ erpEmpty.style.display = 'block'; erpEmpty.textContent = 'Không có dòng nào khớp tìm kiếm.'; }
    if(wmsEmpty){ wmsEmpty.style.display = 'block'; wmsEmpty.textContent = 'Không có dòng nào khớp tìm kiếm.'; }
    if(summaryEl) summaryEl.textContent = 'Không có dòng nào khớp tìm kiếm';
    return;
  }
  if(erpEmpty) erpEmpty.style.display = 'none';
  if(wmsEmpty) wmsEmpty.style.display = 'none';

  const erpRows = [], wmsRows = [];
  rowsInfo.forEach(({ key, status, eq, wq }) => {
    const { item, locator } = cmpSplitKey(key);
    erpRows.push(`<tr class="cmp-${status}"><td>${escHtml(item)}</td><td>${escHtml(locator)}</td><td class="num">${eq===null?'—':fmt(eq)}</td></tr>`);
    wmsRows.push(`<tr class="cmp-${status}"><td>${escHtml(item)}</td><td>${escHtml(locator)}</td><td class="num">${wq===null?'—':fmt(wq)}</td></tr>`);
  });
  erpTbody.innerHTML = erpRows.join('');
  wmsTbody.innerHTML = wmsRows.join('');
  if(summaryEl) summaryEl.textContent = `${fmt(rowsInfo.length)} dòng`;
}

function renderCompareAll(){
  CMP_KHO_CODES.forEach(renderCompareTables);
}

const cmpBtnUpdateErp = document.getElementById('btn-update-erp');
const cmpErpFileInput = document.getElementById('erp-file-input');
const cmpBtnUpdateWms = document.getElementById('btn-update-wms');
const cmpWmsFileInput = document.getElementById('wms-file-input');
const cmpStatusEl = document.getElementById('cmp-upload-status');

async function cmpHandleUpload(file, kind){
  const overlay = document.getElementById('loading-overlay');
  const loadingMsg = document.getElementById('loading-msg');
  if(overlay) overlay.classList.add('show');
  if(loadingMsg) loadingMsg.textContent = `Đang đọc "${file.name}"…`;
  if(cmpStatusEl){ cmpStatusEl.className = 'upload-status'; cmpStatusEl.textContent = 'Đang xử lý…'; }
  try{
    const rows = await cmpReadFileAsRows(file);
    const maps = kind === 'erp' ? cmpParseErpRows(rows) : cmpParseWmsRows(rows);
    const meta = { fileName: file.name, updatedAtText: `Cập nhật lúc ${fmtDateTime(new Date())}` };
    if(kind === 'erp'){ cmpErpMaps = maps; cmpErpMeta = meta; }
    else { cmpWmsMaps = maps; cmpWmsMeta = meta; }

    const updatedEl = document.getElementById(kind === 'erp' ? 'cmp-erp-updated' : 'cmp-wms-updated');
    const fileEl = document.getElementById(kind === 'erp' ? 'cmp-erp-file' : 'cmp-wms-file');
    if(updatedEl) updatedEl.textContent = meta.updatedAtText;
    if(fileEl){ fileEl.textContent = `File: ${file.name}`; fileEl.title = file.name; }

    renderCompareAll();
    cmpSaveToStorage();
    const totalRows = CMP_KHO_CODES.reduce((s,c) => s + (maps[c] ? maps[c].size : 0), 0);
    const perKhoText = CMP_KHO_CODES.map(c => `${c}: ${fmt(maps[c] ? maps[c].size : 0)}`).join(' · ');
    if(cmpStatusEl){
      cmpStatusEl.className = 'upload-status ok';
      cmpStatusEl.textContent = `✓ Đã cập nhật ${kind === 'erp' ? 'ERP' : 'WMS'} từ "${file.name}" (${fmt(totalRows)} dòng — ${perKhoText})`;
    }
  }catch(err){
    console.error('Lỗi khi xử lý file so sánh:', err);
    if(cmpStatusEl){ cmpStatusEl.className = 'upload-status err'; cmpStatusEl.textContent = `✗ Lỗi: ${err.message}`; }
  }finally{
    if(overlay) overlay.classList.remove('show');
  }
}

if(cmpBtnUpdateErp && cmpErpFileInput) cmpBtnUpdateErp.addEventListener('click', () => cmpErpFileInput.click());
if(cmpBtnUpdateWms && cmpWmsFileInput) cmpBtnUpdateWms.addEventListener('click', () => cmpWmsFileInput.click());
if(cmpErpFileInput) cmpErpFileInput.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if(file) cmpHandleUpload(file, 'erp');
  cmpErpFileInput.value = '';
});
if(cmpWmsFileInput) cmpWmsFileInput.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if(file) cmpHandleUpload(file, 'wms');
  cmpWmsFileInput.value = '';
});

const cmpBtnReset = document.getElementById('btn-reset-compare');
if(cmpBtnReset){
  cmpBtnReset.addEventListener('click', () => {
    const hasAny = CMP_KHO_CODES.some(c => cmpErpMaps[c] || cmpWmsMaps[c]);
    if(!hasAny) return;
    if(!confirm('Xoá toàn bộ dữ liệu So sánh (cả ERP và WMS, cả 3 kho) đã lưu trong trình duyệt này?')) return;
    cmpErpMaps = {}; cmpWmsMaps = {}; cmpErpMeta = null; cmpWmsMeta = null;
    cmpClearStorage();
    renderCompareAll();
    ['cmp-erp-updated','cmp-wms-updated'].forEach(id => { const el = document.getElementById(id); if(el) el.textContent = 'Chưa có dữ liệu'; });
    ['cmp-erp-file','cmp-wms-file'].forEach(id => { const el = document.getElementById(id); if(el){ el.textContent = 'File: —'; el.title = ''; } });
    if(cmpStatusEl){ cmpStatusEl.className = 'upload-status'; cmpStatusEl.textContent = 'Đã xoá — Tải file ERP và file WMS (.tsv) để so sánh'; }
  });
}

CMP_KHO_CODES.forEach(code => {
  const searchEl = document.getElementById('cmp-search-' + code);
  if(searchEl) searchEl.addEventListener('input', () => renderCompareTables(code));
});

// Cuộn đồng bộ 2 bảng ERP / WMS trong cùng 1 kho để dễ so sánh theo hàng
CMP_KHO_CODES.forEach(code => {
  const a = document.getElementById('cmp-erp-scroll-' + code);
  const b = document.getElementById('cmp-wms-scroll-' + code);
  if(!a || !b) return;
  let syncing = false;
  function link(src, dst){
    src.addEventListener('scroll', () => {
      if(syncing) return;
      syncing = true;
      dst.scrollTop = src.scrollTop;
      requestAnimationFrame(() => { syncing = false; });
    });
  }
  link(a, b); link(b, a);
});

// Khôi phục dữ liệu So sánh đã lưu (nếu có) khi mở lại trang
function initComparePage(){
  const saved = cmpLoadFromStorage();
  if(saved && (CMP_KHO_CODES.some(c => saved.erp[c]) || CMP_KHO_CODES.some(c => saved.wms[c]))){
    cmpErpMaps = saved.erp; cmpWmsMaps = saved.wms;
    cmpErpMeta = saved.erpMeta; cmpWmsMeta = saved.wmsMeta;
    renderCompareAll();
    if(cmpErpMeta){
      const el = document.getElementById('cmp-erp-updated'); if(el) el.textContent = cmpErpMeta.updatedAtText || 'Đã khôi phục';
      const fEl = document.getElementById('cmp-erp-file'); if(fEl && cmpErpMeta.fileName){ fEl.textContent = `File: ${cmpErpMeta.fileName}`; fEl.title = cmpErpMeta.fileName; }
    }
    if(cmpWmsMeta){
      const el = document.getElementById('cmp-wms-updated'); if(el) el.textContent = cmpWmsMeta.updatedAtText || 'Đã khôi phục';
      const fEl = document.getElementById('cmp-wms-file'); if(fEl && cmpWmsMeta.fileName){ fEl.textContent = `File: ${cmpWmsMeta.fileName}`; fEl.title = cmpWmsMeta.fileName; }
    }
    if(cmpStatusEl){ cmpStatusEl.className = 'upload-status ok'; cmpStatusEl.textContent = '✓ Đã khôi phục dữ liệu So sánh đã lưu trong trình duyệt này'; }
  }
}
initComparePage();
FileVault.registerReloader(initComparePage);

// Áp dụng lại giao diện mỗi khi trạng thái được nạp lại từ file đồng bộ/Cloud (giữ đúng lựa chọn
// giao diện của máy này — không phải dữ liệu đồng bộ giữa các máy, nên persist:false, khỏi ghi đè
// ngược lại localStorage bằng giá trị vừa đọc ra từ chính localStorage).
FileVault.registerReloader(function(){
  if(typeof tn5ApplyTheme === 'function') tn5ApplyTheme(LS.getItem('tn5_theme') || 'light', { persist: false });
});

// Khởi động FileVault + CloudVault sau khi mọi module đã đăng ký hàm nạp lại (reloader)
FileVault.init();
CloudVault.init();

// "Xem dung lượng dữ liệu" — tính đúng dung lượng JSON (byte) của TỪNG mục trong _mem, xếp từ lớn
// tới nhỏ, để người dùng tự biết mục nào đang phình to bất thường thay vì đoán mò. Đây CHÍNH XÁC là
// gói dữ liệu sẽ được gửi lên Cloud/file mỗi lần lưu (writeAll gửi thẳng _mem).
function fmtBytes(n){
  if(n >= 1024*1024) return (n/(1024*1024)).toFixed(2) + ' MB';
  if(n >= 1024) return (n/1024).toFixed(1) + ' KB';
  return n + ' B';
}
function renderStorageSize(){
  const resultEl = document.getElementById('storage-size-result');
  if(!resultEl) return;
  const rows = Object.keys(_mem).map(k => {
    const raw = _mem[k];
    const bytes = typeof raw === 'string' ? new Blob([raw]).size : new Blob([JSON.stringify(raw)]).size;
    return { key: k, label: STORAGE_KEY_LABELS[k] || k, bytes };
  }).sort((a, b) => b.bytes - a.bytes);
  const total = rows.reduce((s, r) => s + r.bytes, 0);
  if(!rows.length){
    resultEl.innerHTML = `<div style="color:var(--muted-2); font-style:italic;">Chưa có dữ liệu nào đang lưu.</div>`;
    return;
  }
  resultEl.innerHTML = `
    <div style="font-weight:700; margin-bottom:6px;">Tổng cộng: ${fmtBytes(total)}${CloudVault && CloudVault.url ? ' (đúng gói sẽ gửi lên Cloud mỗi lần "Lưu")' : ''}</div>
    <table style="width:100%; border-collapse:collapse; font-size:12.5px;">
      ${rows.map(r => `
        <tr style="border-bottom:1px solid var(--line, #e5e5e5);">
          <td style="padding:4px 8px 4px 0;">${escHtml(r.label)}</td>
          <td style="padding:4px 0; text-align:right; font-weight:700; white-space:nowrap; color:${r.bytes > total * 0.3 ? 'var(--red)' : 'inherit'};">${fmtBytes(r.bytes)}</td>
        </tr>`).join('')}
    </table>`;
}
const btnStorageSize = document.getElementById('btn-storage-size');
if(btnStorageSize) btnStorageSize.addEventListener('click', renderStorageSize);

