import { createRoot } from "react-dom/client";

import { App } from "./app.js";
import "./styles.css";

const root = document.getElementById("root");

if (root === null) {
  throw new Error("Architect Lab root element was not found");
}

createRoot(root).render(<App />);
