import type { ReaderStoreStrictApi, StoreChange, StoreMessage } from "../../../typings/reader-store-strict";

declare const store: ReaderStoreStrictApi;
store.put({ url: "book", title: 42, custom: true });
store.putBookmark({ id: "id", url: "book", createdAt: "12" });
store.list(5).then(entries => { const title: string = entries[0].title; return title; });
store.get("book").then(entry => { const time: number | undefined = entry?.lastReadAt; return time; });
store.listBookmarks("book").then(entries => { const label: string = entries[0].label; return label; });
store.subscribe(message => {
  if (message.remote) {
    // @ts-expect-error remote payloads have not been validated
    const url: string = message.url;
    void url;
  } else if (message.type === "history") {
    const time: number = message.lastReadAt;
    void time;
  }
});
// @ts-expect-error url is required
store.put({ title: "book" });
// @ts-expect-error bookmark id is required
store.putBookmark({ url: "book" });
// @ts-expect-error history notifications require a timestamp
const invalid: StoreChange = { type: "history", url: "book" };
// @ts-expect-error unvalidated remote message is not a local message
const local: StoreMessage = { remote: false, type: "unknown" };
void invalid; void local;
