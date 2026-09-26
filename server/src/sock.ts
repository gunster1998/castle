/** То, что игровой логике нужно от соединения (WebSocket из пакета ws этому соответствует). */
export interface Sock {
  readonly readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
}
