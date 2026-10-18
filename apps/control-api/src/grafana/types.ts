export interface GrafanaAnnotationPayload {
  time: number; // epoch milliseconds
  text: string;
  tags: string[];
}

export interface GrafanaAnnotationResponse {
  id?: number;
  message?: string;
  [key: string]: unknown;
}

export interface GrafanaClient {
  createAnnotation(
    payload: GrafanaAnnotationPayload,
  ): Promise<GrafanaAnnotationResponse>;
}
