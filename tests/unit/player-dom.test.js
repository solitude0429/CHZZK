import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Window } from "happy-dom";

import {
  findQualityItem,
  getVisibleQualityLabels,
  setQualityItemDisplay,
  updateCurrentQualityText,
} from "../../src/shared/player-dom.js";

function createDocument(html) {
  const window = new Window();
  window.document.body.innerHTML = html;
  return window.document;
}

describe("player DOM helpers", () => {
  it("finds visible quality labels across current CHZZK selector shapes", () => {
    const document = createDocument(`
      <ul class="pzp-setting-quality-pane__list-container">
        <li class="pzp-ui-setting-quality-item"><span>480p</span></li>
        <li class="pzp-ui-setting-quality-item"><span>720p</span></li>
        <li class="pzp-ui-setting-quality-item"><span>1080p</span></li>
      </ul>
      <div class="other-setting-quality"><ul><li>audio only</li></ul></div>
    `);

    assert.deepEqual(getVisibleQualityLabels(document), ["480p", "720p", "1080p"]);
    assert.equal(findQualityItem(document, "1080p")?.textContent.trim(), "1080p");
  });

  it("marks the selected target quality with a CHZZK badge without using HTML strings", () => {
    const document = createDocument(`
      <ul class="pzp-setting-quality-pane__list-container">
        <li class="pzp-ui-setting-quality-item"><span>1080p</span></li>
      </ul>
    `);
    const item = findQualityItem(document, "1080p");

    assert.equal(setQualityItemDisplay(item, "1080p", { document, badgeText: "CHZZK" }), true);

    assert.equal(item.querySelector(".pzp-ui-track-badge__badge")?.textContent, "CHZZK");
    assert.equal(item.textContent.replace(/\s+/g, " ").trim(), "1080p CHZZK");
  });

  it("updates the current quality label only when the checked item matches the target quality", () => {
    const document = createDocument(`
      <ul class="pzp-setting-quality-pane__list-container">
        <li aria-selected="true"><span>1080p</span></li>
      </ul>
      <div class="pzp-setting-intro-quality"><div><div></div><div><span class="pzp-ui-setting-home-item__value">720p</span></div></div></div>
    `);

    assert.equal(updateCurrentQualityText(document, "1080p", { badgeText: "CHZZK" }), true);
    assert.equal(
      document.querySelector(".pzp-ui-setting-home-item__value")?.textContent.replace(/\s+/g, " ").trim(),
      "1080p CHZZK",
    );
  });
});
