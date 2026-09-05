import { createRoot } from "react-dom/client";
import { App } from "./App";
import "../styles.css";
import "./components/discussion-workspace.css";
import "./components/outcome-workspace.css";

createRoot(document.getElementById("root")!).render(<App />);
