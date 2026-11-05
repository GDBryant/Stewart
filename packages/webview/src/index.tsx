import { render } from "preact";
import { App } from "./App.js";
import { detectBridge } from "./bridge.js";
import { Store } from "./state.js";

const bridge = detectBridge();
const store = new Store(bridge);
const el = document.getElementById("app");
if (el) render(<App store={store} />, el);
export { store, bridge };
