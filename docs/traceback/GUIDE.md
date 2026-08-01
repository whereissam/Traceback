# Traceback — 實際操作指南

給你自己跑、也給你 demo 給別人看。所有指令都可以複製貼上，輸出都是實測過的。

---

## 先講清楚：它做什麼、不做什麼

|             |                                                                                         |
| ----------- | --------------------------------------------------------------------------------------- |
| ✅ **偵測** | 給它一個 npm 套件名，它在沙箱裡跑那個套件的安裝腳本，觀察實際行為，回你一個有證據的判定 |
| ❌ **阻擋** | **沒有做。** 它回傳 `"verdict": "block"` 這個字串，但**不會攔下你的 `npm install`**     |

現在的狀態是「**會給你答案的偵測器**」，不是「**會擋下來的閘門**」。要變成真的擋，需要那層還沒做的 CLI / MCP 攔截。

---

## 0 · 啟動

```bash
bun run dev:all        # API :8787 + UI :5173
curl -s localhost:8787/api/health
```

看到這個才是兩個整合都活著：

```json
{ "ok": true, "llm": "gpt-5.6-luna", "modal": true }
```

- `"modal":true` → 沙箱是真的。`false` 的話會用本地假資料，UI 會標橘色 banner
- `"llm":"gpt-5.6-luna"` → 時間軸由模型寫。`null` 的話規則引擎會寫，判定完全一樣

---

## 1 · 檢查一個真實套件（最有說服力的 demo）

```bash
curl -s -X POST localhost:8787/api/inspect \
  -H 'content-type: application/json' \
  -d '{"package":"esbuild"}' | python3 -m json.tool
```

實際輸出：

```json
{
  "package": "esbuild",
  "version": "0.28.1",
  "lifecycle_scripts": { "postinstall": "node install.js" },
  "has_lifecycle_scripts": true,
  "event_count": 3,
  "telemetry_source": "modal"
}
```

拿 `investigation.id` 跑分析：

```bash
curl -s -X POST localhost:8787/api/investigate/<id> | python3 -m json.tool
```

```json
{
  "verdict": "allow",
  "risk": "low",
  "finding_counts": { "FACT": 3, "CORRELATION": 1, "INFERENCE": 0 },
  "supply_chain_detected": false
}
```

**這才是重點**：esbuild 有一個貨真價實的 `postinstall` hook，它**放行**。一個什麼都標紅的偵測器毫無價值。

### 其他實測過的真實套件

| 套件      | 版本   | 安裝腳本                       | 判定            |
| --------- | ------ | ------------------------------ | --------------- |
| `esbuild` | 0.28.1 | `postinstall: node install.js` | **ALLOW** · low |
| `core-js` | 3.49.0 | `postinstall`                  | **ALLOW** · low |
| `bcrypt`  | 6.0.0  | `install`                      | **ALLOW** · low |
| `lodash`  | 4.18.1 | 無                             | 沒東西可跑      |
| `sharp`   | 0.35.3 | 無                             | 沒東西可跑      |

隨便挑一個 npm 上的套件都可以試。第一次跑要 40–90 秒（要下載 + 開容器）。

---

## 2 · 惡意套件長什麼樣

真的惡意套件不會留在 npm 上（會被下架），所以我們用一個受控的：

```bash
curl -s -X POST localhost:8787/api/simulate -d '{}' -H 'content-type: application/json'
curl -s -X POST localhost:8787/api/investigate/<id> | python3 -m json.tool
```

```json
{
  "verdict": "block",
  "risk": "high",
  "finding_counts": { "FACT": 7, "CORRELATION": 3, "INFERENCE": 2 },
  "supply_chain_detected": true
}
```

**同一個引擎、同一套規則**，只是輸入的行為不同。

---

## 3 · 它到底怎麼知道是惡意的？

這是最常被問的。答案是：**看行為，不看程式碼**。

### 步驟一：先不執行

```bash
npm install <pkg> --ignore-scripts
```

下載檔案，但**不跑**任何 `preinstall` / `install` / `postinstall`。

### 步驟二：讀它自己宣告的 hook

從 `node_modules/<pkg>/package.json` 裡撈：

```json
{ "scripts": { "postinstall": "node install.js" } }
```

沒有 hook → 到此為止，**沒東西可以引爆**（lodash 就是這種）。

### 步驟三：放誘餌，然後在沙箱裡引爆

沙箱裡先鋪好假憑證：

```
/work/.env               API_KEY=TRACEBACK_CANARY_a91f4c27
/work/.aws/credentials   aws_secret_access_key = TRACEBACK_CANARY_...
/work/.ssh/id_rsa        -----BEGIN OPENSSH PRIVATE KEY-----
```

這些全都是假的，沒有任何權限。它們唯一的作用是：**如果套件去讀它們，我們會知道；如果它們的內容跑出去，我們會認得。**

然後用 `strace` 跑 hook：

```bash
strace -f -tt -e trace=execve,openat,read,connect,clone -o trace.log \
  sh -c "node install.js"
```

### 步驟四：從系統呼叫還原行為

`strace` 攔到的是**核心層**的動作，不是套件自己說它做了什麼：

```
execve("/usr/bin/node", ["node", "install.js"])     → 它開了一個 process
openat(AT_FDCWD, "/work/.env", O_RDONLY) = 17       → 它打開了 .env
read(17, ...)                                        → 它真的讀了內容
connect(18, {AF_INET, "104.21.x.x"})                 → 它對外連線了
```

這就是「不相信套件說什麼，觀察它做什麼」的實作。套件可以在程式碼裡騙你，但它騙不了 `openat`。

### 步驟五：規則判定

| 觀察到                                                              | 判定                            |
| ------------------------------------------------------------------- | ------------------------------- |
| 讀 `.env` / `.ssh` / `.aws` **而且**對外連線（同一個 process tree） | **BLOCK**                       |
| 改 `.github/workflows` / `Dockerfile` / `package.json`              | **BLOCK**                       |
| 誘餌字串出現在送出去的內容裡                                        | **BLOCK**，而且是 FACT 不是推測 |
| 有對外連線，但沒碰敏感檔案                                          | **REVIEW**                      |
| 只在自己目錄裡寫東西、沒對外連線                                    | **ALLOW**                       |

規則寫在 `server/verdict.ts`，是**決定性的** —— 不是模型猜的，跑兩次結果一樣。

### 關鍵：兩個訊號才算數

`npm install` 觸發 `postinstall` 是**極度正常**的事（半個 npm 生態都這樣）。所以：

- 「有安裝」+「有 hook」→ **不會**觸發任何警告
- 必須要有**風險行為**（讀憑證 / 對外連線 / 改部署檔）才會

這就是為什麼 esbuild 會過。它有 hook、有開 process，但沒碰任何敏感的東西。

---

## 4 · 誘餌：把推測變成事實

一般情況下，「秘密到底有沒有被送出去」是答不出來的 —— 你看到讀檔案，320 毫秒後看到對外連線，但你沒看到封包內容。

所以只能說：

```
INFERENCE   可能有憑證外洩   (medium)
```

但如果誘餌字串 `TRACEBACK_CANARY_a91f4c27` 出現在**離開容器的資料**裡，那就不是推測了：

```
FACT        合成憑證確實被送出   (high)
```

而且這時候系統會**把原本那個比較弱的推測收回去**，不會讓猜測跟證據並排放著。

---

## 5 · UI demo 順序

開 <http://localhost:5173/traceback>

1. **上面的輸入框**打 `esbuild` → 按 Inspect
   → 「一個真實的、有 postinstall hook 的正常套件，它放行了」
2. **按 Run simulation** → 指著原始事件表
   → 「六行 telemetry，每行都真，沒有一行解釋任何事」
3. **按 Build timeline**（約 9 秒）
   → 「它在關聯事件，模型在寫時間軸 —— 但模型看不到原始 telemetry」
4. **BLOCKED 卡片** → 指著右邊 **Not confirmed** 那欄
   → 「它老實說它沒能確認的東西」
5. **捲到 INFERENCE** → 指著 Confirm 按鈕
   → 「機器不會自己按這個」

---

## 6 · 抓不到的情況

要老實講，因為評審一定會問：

| 情況                                        | 結果                                                                   |
| ------------------------------------------- | ---------------------------------------------------------------------- |
| 把偷到的東西**加密**再送                    | 誘餌不會出現 → 退回 **INFERENCE**，判定變 `review`。**少說，不會多說** |
| 套件偵測到自己在沙箱裡就裝乖                | **抓不到**。動態分析的通病                                             |
| 惡意行為不在安裝時，而在你 `require()` 之後 | **抓不到**。我們只觀察安裝階段                                         |
| 惡意的是依賴的依賴                          | 目前只跑最上層那個套件的 hook                                          |

前兩項是這類工具的本質限制，不是調參數能解決的。

---

## 7 · 出事的時候

| 狀況                          | 怎麼辦 / 怎麼講                                                                       |
| ----------------------------- | ------------------------------------------------------------------------------------- |
| 橘色 banner「local fallback」 | **講出來**：Modal 連不上，退回本地資料而且標示了。fallback 永遠不會被當成真的沙箱結果 |
| `generated by rule-engine`    | 沒有 API key，決定性引擎寫的 —— 正確性不依賴模型                                      |
| inspect 超過 90 秒            | 第一次跑要下載 + 開容器，正常。第二次會快                                             |
| `502` 或 sandbox 錯誤         | Modal 那邊掛了。改用 Run simulation（本地 fixture 路徑）                              |
| 全掛                          | 開另一個分頁 —— 跑完的調查都在 Supabase，重新載入就有                                 |

**上台前**：先完整跑一次，分頁不要關，當保險。

---

## 8 · 一句話總結

> 它不看程式碼寫了什麼，它在沙箱裡跑一遍，看核心層實際發生了什麼，然後用可以讀的規則給你一個判定 —— 每個結論都標了「這是事實」還是「這是推測」。
>
> 但它現在**只會告訴你**，不會替你擋。
