/**
 * Tipos que ainda não estão no lib.dom do TypeScript.
 */

interface DocumentPictureInPictureOptions {
  width?: number;
  height?: number;
  disallowReturnToOpener?: boolean;
  preferInitialWindowPlacement?: boolean;
}

interface DocumentPictureInPicture extends EventTarget {
  readonly window: Window | null;
  requestWindow(options?: DocumentPictureInPictureOptions): Promise<Window>;
}

interface Window {
  documentPictureInPicture?: DocumentPictureInPicture;
  __COPILOTO_QS__?: boolean;
  __COPILOTO_VIGIA__?: boolean;
  __COPILOTO_LEMBRETE__?: boolean;
}

/** `mandatory` do chromeMediaSource não está tipado no lib.dom. */
interface MediaTrackConstraints {
  mandatory?: {
    chromeMediaSource: "tab" | "desktop";
    chromeMediaSourceId: string;
  };
}
