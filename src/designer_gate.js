/**
 * ============================================================================
 *  人工確認關卡 — 實作節錄
 *  The human confirmation gate — excerpt
 * ----------------------------------------------------------------------------
 *  這是一條四段式產線的第 ④ 段。前後文：
 *
 *    ③ 產生器（每小時）  建立設計、填入版面，寫 status = "awaiting_designer"
 *       → 這一段把編輯連結和「⏸ 待設計師確認」寫回主表，不下載任何東西
 *
 *    ④ 設計師進編輯器檢查／調整，回主表勾「★設計師已完成，可匯出圖片」   ← 本檔
 *
 *    ⑤ 匯出器（每 10 分鐘）  匯出 JPG，寫 status = "ok" + 張數
 *       → 圖一落檔就把勾清掉
 *
 *  ⚠️ 這個勾選欄的語意是「請出圖」的**一次性請求**，不是「已確認過」的長期記號。
 *     完整理由見 README 的「一個花了兩週才想通的設計決定」。
 *
 *  節錄自營運中的 Google Apps Script 專案。所有 ID 與帳號已換成佔位符，
 *  品牌名以 BRAND_A / BRAND_B 代稱。此檔可讀不可跑。
 * ============================================================================
 */

var CFG = {
  EXCHANGE_FOLDER_ID: '<REDACTED_FOLDER_ID>',   // 兩側交換 TASK_*.json 的資料夾
  SHEET_NAME: '產線主表',
  HEADER_ROWS: 1,

  POLL_EVERY_MINUTES: 10,

  // ③ 與 ⑤ 都改成「一個 SKU（或 SKU×品牌）寫一個 TASK 檔」之後，一輪產生的檔案數
  // 比舊版的單一大檔多十幾倍。這個上限太小會讓交換區持續積壓，而積壓會讓 ⑤ 看不到
  // 狀態變化、每輪重複匯出同一批。真正的煞車是下面的 MAX_RUNTIME_MS。
  MAX_TASK_FILES_PER_RUN: 20,
  MAX_RUNTIME_MS: 4.5 * 60 * 1000,   // 4.5 分鐘就收手（平台上限 6 分鐘）
  DOWNLOAD_RETRY: 2,

  // 狀態文字。這些字串會被寫進試算表，下游有公式在讀，改字要同步改公式。
  ST_WAITING:  '⏳ 等待商品名稱',
  ST_AWAITING: '⏸ 待設計師確認',    // 設計已建好填好，等設計師勾選放行才會匯出
  ST_PARTIAL:  '部分完成',
  ST_EXPIRED:  '匯出連結已逾期',
  ST_FAILED:   '失敗',
};

var DESIGNER_OK_TITLE = '★設計師已完成，可匯出圖片';


/**
 * 處理一個 TASK 項目。
 *
 * 這個函式的核心是「哪些狀態不是失敗」——早期版本把所有非 ok 的狀態都當失敗寫進表裡，
 * 結果表上滿是紅字，而其中大多數只是「還沒輪到」。分清楚之後，紅字才重新有意義。
 */
function processTaskItem_(sh, item) {
  var sku   = String(item.sku || '').trim();
  var brand = String(item.brand || '').toUpperCase();
  var bcfg  = brandCfg_(brand);

  if (!bcfg) {
    // 沒有品牌欄位或品牌名稱打錯字，屬於上游排程的 bug。
    // 明確報錯，不要猜一個品牌 —— 猜錯會把圖寫進另一個品牌的資料夾，而且沒人會發現。
    throw new Error('未知或缺少品牌欄位：brand="' + item.brand + '"（必須是 ' +
      BRANDS.map(function (b) { return b.key; }).join(' 或 ') + '）');
  }

  // 「等待商品名稱」不是失敗：名稱欄還沒填，本輪先不套版，下一輪會自己再撿起來。
  if (item.status === 'waiting_name') {
    writeBackRows_(sh, item, brand, '', '', CFG.ST_WAITING);
    return { saved: 0, failed: 0 };
  }

  // 「待設計師確認」也不是失敗：③ 已經把設計建好、填好版，
  // 接下來要等設計師檢查調整、回主表勾選放行，⑤ 才會去匯出 JPG。
  // 這裡只寫連結和狀態，不下載任何東西。
  if (item.status === 'awaiting_designer') {
    var awaitRows = writeBackRows_(sh, item, brand, item.edit_url || '', '', CFG.ST_AWAITING);
    clearDesignerOk_(sh, awaitRows, '有新設計進到待確認');
    return { saved: 0, failed: 0 };
  }

  // 上游就已判定失敗的品項，直接寫狀態，不重試。
  if (item.status && item.status !== 'ok') {
    writeBackRows_(sh, item, brand, item.edit_url || '', '',
                   CFG.ST_FAILED + '：' + (item.note || item.status));
    return { saved: 0, failed: 1 };
  }

  // --- 以下是真的要下載落檔的路徑 ---
  var result = downloadPages_(item, bcfg, sku);
  var status = statusTextFor_(result);
  var okRows = writeBackRows_(sh, item, brand, item.edit_url || '', result.folderUrl, status);

  // 圖已經落地 → 這次的出圖請求執行完了，把勾清掉。
  //
  // 不清會發生什麼：因為 ⑤ 現在連狀態是「完成」的列也會重新檢查（這是為了讓
  // 「再勾一次＝重出圖」能生效），所以留著的勾會讓這一列每 10 分鐘被重匯一次，
  // 永遠停不下來。
  if (result.saved > 0) clearDesignerOk_(sh, okRows, '圖已出好');

  return result;
}


/**
 * 把該列的「★設計師已完成，可匯出圖片」勾清掉。
 *
 * 這一欄的語意是**「請出圖」的一次性請求**，不是「已確認過」的長期記號。
 *
 * 兩個時機會清：
 *   1. 圖已經出好落檔（reason = '圖已出好'）
 *      —— 請求執行完了。理由見上面 processTaskItem_ 的註解。
 *
 *   2. 有新設計進到「待設計師確認」（reason = '有新設計進到待確認'）
 *      —— 這一欄同時管兩個品牌。舊的勾若留著，晚一步才建好的另一個品牌
 *         會直接繼承它被自動匯出，**設計師根本沒看過那份設計**。
 *         這是上線第三天撞到的，也是把這一欄改成一次性請求的直接原因。
 */
function clearDesignerOk_(sh, rows, reason) {
  if (!COL.DESIGNER_OK || !rows) return;

  // 同款組是「代表列勾一次、整組生效」，但清的時候整組都清：
  // 這一欄有資料驗證是核取方塊，任何一列被人順手勾了都會讓 ⑤ 重撿，清乾淨最省事。
  var list = (typeof rows === 'number') ? [rows] : rows;

  for (var i = 0; i < list.length; i++) {
    var row = list[i];
    if (!row || row < 0) continue;

    var cell = sh.getRange(row, COL.DESIGNER_OK);
    if (cell.getValue() === true) {
      cell.setValue(false);
      Logger.log('    ↺ 第 ' + row + ' 列' + (reason || '') + '，已取消放行勾選。');
    }
  }
}


/**
 * 找列：優先用來源資料夾 ID 比對，找不到再退回文字比對。
 *
 * 為什麼不用 SKU 直接比：SKU 會被改名（改錯字、改命名規則），而資料夾 ID 不會。
 * 用 ID 比對的話，SKU 改名之後這一列還是找得到；用文字比對的話，改名等於斷線，
 * 而斷線的症狀是「靜靜地新增一列」，沒有任何錯誤訊息。
 */
function findRowsFor_(sh, item) {
  var byId = findRowsByFolderId_(sh, item.source_folder_id);
  if (byId.length) return byId;
  return findRowsBySkuText_(sh, item.sku);
}
