"""無人值守排程的健康檢查 — 節錄
Health checks for unattended scheduled agents — excerpt

這是產線第 ⑧ 段（見 README 架構圖）。它每天跑一次，回答一個問題：
**那 8 支排程今天有沒有在做事？**

「有沒有在做事」跟「有沒有被觸發」是兩件事，而多數監控只驗得到後者。
這個檔案的兩個函式分別處理這條線上最容易騙人的兩種情況：

  is_spent_oneoff()   一次性任務跑完會自動停用 —— 那是正常終態，不是故障
  liveness_verdict()  排程「沒動作」可能是正確閒置，也可能是排程器不再觸發它

節錄自營運中的專案，排程名稱已代稱化。邏輯未改動。
"""

from datetime import datetime


def is_spent_oneoff(task, now_ms=None) -> bool:
    """這支是不是「一次性任務跑完之後的正常終態」。

    一次性任務（有 `fireAt`、沒有 `cronExpression`）觸發完會**自動停用**——
    那是設計如此，不是有人動了它，也不是漂移。
    但基準線記的是建立當下的 `True`，於是每有一支一次性任務跑完，
    體檢就開始報「啟用狀態與基準線不符」，要有人回來手動改成 `False`。

    這件事發生三次之後（三支不同的一次性任務），才意識到問題不在人漏改，
    在於「檢查沒有能力分辨正常終態與故障」。而中間任何一環漏掉，
    體檢就會紅在一個跟真正問題無關的理由上——**假警報會訓練人忽略警報**。

    三個條件要同時成立，缺一不可：
      - 沒有 `cronExpression` —— 週期性排程被停用是真的要有人管
      - 有 `fireAt` 而且**已經過了** —— 還沒到就被停用，那是有人提早關掉它，要報
      - `enabled` 是 false —— 還開著就還沒走到終態
    """
    if not isinstance(task, dict):
        return False
    if task.get("cronExpression"):
        return False
    fire = task.get("fireAt")
    if not isinstance(fire, (int, float)):
        return False
    if task.get("enabled") is not False:
        return False
    if now_ms is None:
        now_ms = datetime.now().timestamp() * 1000
    return fire < now_ms


def liveness_verdict(task, now, tolerance, label=None):
    """一支排程最近有沒有照 cron 在跑。回傳 (狀態, 訊息)，狀態是 ok／bad／skip。

    **skip 的意思是「這次驗不到」，不是「沒問題」。** 任何解析失敗都要走 bad 或
    skip，絕不能因為看不懂欄位就靜靜地當成健康 —— 這支腳本要防的就是靜默故障。

    `label` 是給人看的短名；失敗訊息一律用它開頭，因為那一段會被截成手機推播的
    標題。訊息裡仍然帶完整的任務 id，供實際去查的人用。
    """
    name = task.get("id") or "（沒有 id 的排程）"
    label = label or name

    if not task.get("enabled"):
        return "skip", f"{name} 目前停用中，存活檢查不適用"

    expr = task.get("cronExpression")
    if not expr:
        return "skip", f"{name} 沒有 cronExpression（一次性任務？），存活檢查不適用"

    try:
        slots = prev_fire_times(expr, now, count=tolerance)
    except ValueError as e:
        return "bad", f"{name} 的 cron 解析失敗（'{expr}'：{e}），沒辦法判斷它該不該跑過"

    if not slots:
        return "skip", f"{name} 最近 10 天內沒有任何排程時刻（cron：{expr}），沒東西可比"

    raw = task.get("lastRunAt")
    if raw is None:
        return "bad", (f"{label}沒跑過：{name} 是啟用中的排程，但真身 JSON 裡"
                       f"沒有 lastRunAt —— 它可能一次都沒被觸發過")

    last = _parse_epoch(raw)
    if last is None:
        # 這一條特別重要：欄位格式改了的話，「看不懂」會被誤讀成「沒問題」。
        return "bad", (f"{label}驗不了：{name} 的 lastRunAt 看不懂（{raw!r}），"
                       f"存活檢查等於沒做。這個欄位的格式可能改了，請更新 _parse_epoch")

    oldest_allowed = slots[-1]
    if last >= oldest_allowed:
        return "ok", (f"{name} 最近有在跑（最後一輪 {last:%m-%d %H:%M}，"
                      f"上一個排程時刻 {slots[0]:%m-%d %H:%M}）")

    extra = ""
    skips = task.get("recordedSkips")
    if isinstance(skips, list) and skips:
        # 只講數量。這個欄位的結構同樣沒驗證過，硬解裡面的時間會製造假警報。
        extra = f"（另外真身 JSON 裡記了 {len(skips)} 筆略過紀錄，值得一起看）"

    return "bad", (f"{label}沒在跑了：{name} 最後一輪是 {last:%m-%d %H:%M}，"
                   f"但依 cron（{expr}）它最晚該在 {oldest_allowed:%m-%d %H:%M} 跑過 —— "
                   f"已容許連續漏跑 {tolerance - 1} 輪，"
                   f"排程器可能已經不再觸發它{extra}")


# ---------------------------------------------------------------------------
# 刻意不做的事
#
# 產線第 ⑦ 段（ERP 建檔）沒有放進存活檢查，是刻意的：那條線漏跑的偵測
# 已經由備份主線負責 —— 它每天檢查資料的匯出時間，超過 10 天沒更新就讓
# 整個備份失敗。
#
# **那個檢查看的是「資料有沒有真的更新」，比「排程有沒有觸發」更貼近
# 我們真正在意的事**，而且它連整台機器關機都抓得到。兩邊都設會變成
# 同一件事發兩次警報，而重複警報跟假警報一樣會訓練人忽略它。
# ---------------------------------------------------------------------------
