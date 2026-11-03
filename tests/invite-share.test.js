import test from "node:test";
import assert from "node:assert/strict";
import { shareRoomInvite } from "../static/js/network/invite-share.js";

test("shares an invite through the device share sheet", async () => {
  let payload;
  const result = await shareRoomInvite({ url: "https://game.test/?room=123456", share: async value => { payload = value; } });
  assert.equal(result, "shared");
  assert.equal(payload.url, "https://game.test/?room=123456");
  assert.match(payload.text, /加入房间/);
});

test("falls back to copy when sharing is unavailable or fails", async () => {
  let copied = "";
  const copy = async value => { copied = value; };
  assert.equal(await shareRoomInvite({ url: "https://game.test/?room=123456", copy }), "copied");
  assert.equal(copied, "https://game.test/?room=123456");
  assert.equal(await shareRoomInvite({ url: "https://game.test/", share: async () => { throw Error("unsupported"); }, copy }), "copied");
});

test("a cancelled share stays cancelled and invalid links are rejected", async () => {
  let copied = false;
  const result = await shareRoomInvite({ url: "https://game.test/", share: async () => { const error = Error(); error.name = "AbortError"; throw error; }, copy: async () => { copied = true; } });
  assert.equal(result, "cancelled");
  assert.equal(copied, false);
  assert.equal(await shareRoomInvite({ url: "" }), "unavailable");
});
