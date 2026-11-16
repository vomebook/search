import type { PageWindowContext, PdfOutlineDocument, DjvuOutlineDocument, PageWindowHandle } from '../../../typings/reader-page-window-strict';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
export type VisibilityIsNotGuard = Assert<Equal<PageWindowContext['isPdfPageVisible'] extends (shell: Element | null | undefined) => shell is Element ? true : false, false>>;
export type VisibilityReturnsBoolean = Assert<Equal<ReturnType<PageWindowContext['isPdfPageVisible']>, boolean>>;
export type PdfReference = Assert<Equal<Parameters<PdfOutlineDocument['getPageIndex']>[0], object>>;
export type DjvuReference = Assert<Equal<Parameters<DjvuOutlineDocument['getPageIndex']>[0], number>>;
export type EnsureResult = Assert<Equal<ReturnType<PageWindowHandle['ensure']>, Element | null>>;
