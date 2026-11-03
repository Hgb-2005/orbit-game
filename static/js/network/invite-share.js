/** 使用设备系统分享好友房间；分享不可用时保留可复制邀请链接。 */
export async function shareRoomInvite({ url, share, copy }) {
  if (typeof url !== "string" || !url) return "unavailable";
  if (typeof share === "function") {
    try {
      await share({
        title: "微光球场 · 好友房间",
        text: "来微光球场和我一起玩，打开链接即可加入房间。",
        url,
      });
      return "shared";
    } catch (error) {
      if (error?.name === "AbortError") return "cancelled";
    }
  }
  if (typeof copy === "function") {
    try { await copy(url); return "copied"; }
    catch { return "manual"; }
  }
  return "manual";
}
