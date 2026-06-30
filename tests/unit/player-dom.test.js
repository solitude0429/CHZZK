import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Window } from "happy-dom";

import {
  GRID_BYPASS_BADGE_TEXT,
  GRID_BYPASS_DISPLAY_QUALITY,
  SOURCE_QUALITY,
  findCheckedQualityItem,
  findSourceQualityItem,
  renderGridBypassQualityLabel,
  updateCurrentGridBypassQualityText,
} from "../../src/shared/player-dom.js";

function createDocument(html) {
  const window = new Window();
  window.document.body.innerHTML = html;
  return window.document;
}

describe("player DOM helpers", () => {
  it("finds the 480p player menu item that triggers the grid-bypass redirect", () => {
    const document = createDocument(`
      <ul class="pzp-setting-quality-pane__list-container">
        <li class="pzp-ui-setting-quality-item"><span>360p</span></li>
        <li class="pzp-ui-setting-quality-item"><span>${SOURCE_QUALITY}</span></li>
        <li class="pzp-ui-setting-quality-item"><span>720p</span></li>
      </ul>
    `);

    assert.equal(findSourceQualityItem(document)?.textContent.trim(), SOURCE_QUALITY);
  });

  it("relabels only the 480p item as the 1080p grid-bypass option", () => {
    const document = createDocument(`
      <ul class="pzp-setting-quality-pane__list-container">
        <li class="pzp-ui-setting-quality-item"><span>480p</span></li>
        <li class="pzp-ui-setting-quality-item"><span>720p</span></li>
      </ul>
    `);
    const sourceItem = findSourceQualityItem(document);

    assert.equal(renderGridBypassQualityLabel(sourceItem, { document }), true);

    assert.equal(sourceItem.querySelector(".pzp-ui-track-badge__badge")?.textContent, GRID_BYPASS_BADGE_TEXT);
    assert.equal(
      sourceItem.textContent.replace(/\s+/g, " ").trim(),
      `${GRID_BYPASS_DISPLAY_QUALITY} ${GRID_BYPASS_BADGE_TEXT}`,
    );
    assert.equal(document.querySelectorAll("li")[1].textContent.trim(), "720p");
  });

  it("updates the intro quality text when the relabeled 480p item is selected", () => {
    const document = createDocument(`
      <ul class="pzp-setting-quality-pane__list-container">
        <li class="pzp-ui-setting-quality-item pzp-ui-setting-pane-item--checked"><span>${GRID_BYPASS_DISPLAY_QUALITY} ${GRID_BYPASS_BADGE_TEXT}</span></li>
      </ul>
      <div class="pzp-setting-intro-quality"><div><div></div><div><span class="pzp-ui-setting-home-item__value">480p</span></div></div></div>
    `);

    assert.equal(
      findCheckedQualityItem(document)?.textContent.trim(),
      `${GRID_BYPASS_DISPLAY_QUALITY} ${GRID_BYPASS_BADGE_TEXT}`,
    );
    assert.equal(updateCurrentGridBypassQualityText(document), true);
    assert.equal(
      document.querySelector(".pzp-ui-setting-home-item__value")?.textContent.replace(/\s+/g, " ").trim(),
      `${GRID_BYPASS_DISPLAY_QUALITY} ${GRID_BYPASS_BADGE_TEXT}`,
    );
  });
});
