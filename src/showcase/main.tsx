import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import "../ui/tokens.css";
import "../ui/components.css";
import "./showcase.css";
import { Gallery } from "./Gallery";
import type { Lang } from "../ui/i18n";

/**
 * DESIGN 10: build the gallery first and confirm it before assembling the real
 * UI. Themes and languages are shown side by side so a token that only works in
 * one of them cannot slip through.
 */

type Column = { theme: "light" | "dark"; lang: Lang };

function Showcase() {
  const [lang, setLang] = useState<Lang>("zh-CN");
  const [bilingual, setBilingual] = useState(false);

  const other: Lang = lang === "zh-CN" ? "en" : "zh-CN";
  const columns: Column[] = bilingual
    ? [
        { theme: "light", lang },
        { theme: "dark", lang },
        { theme: "light", lang: other },
        { theme: "dark", lang: other }
      ]
    : [
        { theme: "light", lang },
        { theme: "dark", lang }
      ];

  return (
    <div className="sx-shell" data-theme="light">
      <div className="sx-bar">
        <strong>ChatExplorer · Components</strong>
        <label>
          <input
            className="switch"
            type="checkbox"
            checked={lang === "en"}
            onChange={(e) => setLang(e.target.checked ? "en" : "zh-CN")}
          />
          English
        </label>
        <label>
          <input
            className="switch"
            type="checkbox"
            checked={bilingual}
            onChange={(e) => setBilingual(e.target.checked)}
          />
          双语并排 / Both languages
        </label>
      </div>

      <div className="sx-columns">
        {columns.map((col, i) => (
          <div key={i} className="sx-column" data-theme={col.theme}>
            <div className="sx-column-head">
              {col.theme === "light" ? "Light" : "Dark"} · {col.lang}
            </div>
            <Gallery lang={col.lang} />
          </div>
        ))}
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Showcase />
  </StrictMode>
);
