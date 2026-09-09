import { Worker } from "effect-cf";
import { applicationLayer, fetch } from "./http";

export default Worker.make(applicationLayer, { fetch });
