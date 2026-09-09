import { Worker } from "effect-cf";
import { applicationLayer, fetch } from "./http";

export default Worker.makeFetchHandler(applicationLayer, { fetch });
