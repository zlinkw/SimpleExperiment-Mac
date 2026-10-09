/**
 * Factory Infrastructure - Common Types (Phase 0+1)
 * 遵循 docs/architecture-factory-refactor-plan.md §3.1 通用基础设施
 * 所有工厂均实现以下抽象接口，Composition Root 唯一组装使用。
 */

import type * as vscode from "vscode";
import type { ClusterStore } from "../state/ClusterStore";
import type { OperationQueue } from "../core/OperationQueue";
import type { RequestBudgetConfig } from "../tunnel/RequestBudget";

export interface FactoryContext {
  readonly extensionUri: vscode.Uri;
  readonly globalState: vscode.Memento;
  readonly workspaceState: vscode.Memento;
  readonly secrets?: vscode.SecretStorage;
  readonly clusterStore?: ClusterStore;
  readonly operationQueue?: OperationQueue;
  readonly requestBudgetConfig?: RequestBudgetConfig;
  // 透传扩展字段，保持兼容
  readonly [key: string]: unknown;
}

export interface Factory<TProduct> {
  create(ctx: FactoryContext): TProduct;
}

export interface DisposableFactory<T extends { dispose(): unknown }> extends Factory<T> {
  create(ctx: FactoryContext): T;
}

export interface FactoryProduct {
  readonly kind: string;
}

export type FactoryCreateOptions = {
  readonly ctx: FactoryContext;
  readonly overrides?: Record<string, unknown>;
};

export interface BatchFactory<TProduct> extends Factory<TProduct> {
  createAll(ctx: FactoryContext): TProduct[];
  createByName?(name: string, ctx: FactoryContext): TProduct | undefined;
}

export interface AsyncFactory<TProduct> {
  createAsync(ctx: FactoryContext): Promise<TProduct>;
}
