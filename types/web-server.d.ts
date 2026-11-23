export function startWebServer(): any;
export namespace webServerInternals {
    export { resolveRequestedModel };
    export { resolveRequestedImageModel };
    export { resolveRequestedSize };
    export { resolveStoredModel };
}
export const app: any;
declare function resolveRequestedModel(value: any): string;
declare function resolveRequestedImageModel(value: any): string;
declare function resolveRequestedSize(value: any): string;
declare function resolveStoredModel(value: any): string;
export {};
