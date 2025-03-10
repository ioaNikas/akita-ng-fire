import { QueryFn, DocumentChangeAction } from '@angular/fire/firestore';
import { Observable, combineLatest, Subscription, of } from 'rxjs';
import { arrayUpdate, arrayAdd, arrayRemove, withTransaction, arrayUpsert } from '@datorama/akita';
import { tap, finalize } from 'rxjs/operators';
import { CollectionService, CollectionState } from '../collection/collection.service';
import { getIdAndPath } from './id-or-path';

export type TypeofArray<T> = T extends (infer X)[] ? X : T;

export type Query<T> = {
  path: string;
  queryFn?: QueryFn;
} & SubQueries<TypeofArray<T>>;

export type QueryLike<T> = Query<T> | Query<T>[];
export type SubQueries<T> = {
  [K in keyof Partial<T>]: (QueryLike<T[K]> | T[K]) | ((entity: T) => QueryLike<T[K]> | T[K])
};

interface CollectionChild<E> {
  parentId: string;
  key: Extract<keyof E, string>;
}

interface SubscriptionMap {
  [id: string]: Subscription;
}

function getSubQuery<E, K extends keyof E>(query: SubQueries<E>[K], parent: E): SubQueries<E>[K] {
  if (typeof query !== 'function') {
    return query;
  }
  return query(parent);
}


export function isDocPath(path: string) {
  return path.split('/').length % 2 === 0;
}

/** Transform a path into a collection Query */
export function collection<T = any>(path: string, queryFn?: QueryFn): Query<T[]> {
  return { path, queryFn } as Query<T[]>;
}

/** Transform a path into a doc query */
export function doc<T = any>(path: string): Query<T> {
  return { path } as Query<T>;
}

/** Check if a value is a query */
function isQuery<T>(query: any): query is Query<T> {
  if (typeof query === 'object') {
    return !!query['path'];
  }
  return false;
}


/**
 * Sync the collection
 * @param this Uses this function with bind on a Collection Service
 * @param query The query to trigger
 */
export function syncQuery<E>(
  this: CollectionService<CollectionState<E>>,
  query: Query<E>
): Observable<any> {

  // If single query
  if (typeof query === 'string') {
    return isDocPath(query)
      ? this.syncDoc({ path: query })
      : this.syncCollection(query);
  }

  if (Array.isArray(query)) {
    return combineLatest(query.map(oneQuery => syncQuery.bind(this, oneQuery)));
  }

  if (!isQuery(query)) {
    throw new Error('Query should be either a path, a Query object or an array of Queries');
  }


  ////////////////
  // SUBQUERIES //
  ////////////////

  /** Listen on Child actions */
  const fromChildAction = (actions: DocumentChangeAction<any>[], child: CollectionChild<E>) => {
    const idKey = 'id'; // TODO: Improve how to
    const { parentId, key } = child;
    for (const action of actions) {
      const id = action.payload.doc.id;
      const data = action.payload.doc.data();

      switch (action.type) {
        case 'added': {
          this['store'].update(parentId as any, (entity) => ({
            [key]: arrayUpsert(entity[key] as any || [], id, data, idKey)
          }) as any);
          break;
        }
        case 'removed': {
          this['store'].update(parentId as any, (entity) => ({
            [key]: arrayRemove<E>(entity[key] as any, id, idKey)
          }) as any);
          break;
        }
        case 'modified': {
          this['store'].update(parentId as any, (entity) => ({
            [key]: arrayUpdate<E>(entity[key] as any, id, data, idKey)
          }) as any);
        }
      }
    }
  };

  /**
   * Stay in sync a subquery of the collection
   * @param subQuery The sub query based on the entity
   * @param child An object that describe the parent
   */
  const syncSubQuery = <K extends keyof E>(
    subQuery: SubQueries<E>[K],
    child: CollectionChild<E>
  ): Observable<unknown> => {
    const { parentId, key } = child;
    // If it's a static value
    if (!isQuery(subQuery)) {
      const update = this['store'].update(parentId as any, {[key]: subQuery} as any);
      return of(update);
    }

    if (Array.isArray(subQuery)) {
      const syncQueries = subQuery.map(oneQuery => {
        if (isQuery(subQuery)) {
          const id = getIdAndPath({ path: subQuery.path });
          return this['db'].doc<E[K]>(subQuery.path).valueChanges().pipe(
            tap((childDoc: E[K]) => {
              this['store'].update(parentId as any, (entity) => ({
                [key]: arrayAdd(entity[key] as any, id, childDoc)
              }) as any);
            })
          );
        }
        return syncSubQuery(oneQuery, child);
      });
      return combineLatest(syncQueries);
    }

    if (typeof subQuery !== 'object') {
      throw new Error('Query should be either a path, a Query object or an array of Queries');
    }

    // Sync subquery
    if (isDocPath(subQuery.path)) {
      return this['db'].doc<E[K]>(subQuery.path).valueChanges().pipe(
        tap((children: E[K]) => this['store'].update(parentId as any, { [key]: children } as any))
      );
    } else {
      return this['db'].collection<E>(subQuery.path, subQuery.queryFn)
        .stateChanges()
        .pipe(
          withTransaction(actions => fromChildAction(actions, child))
        ) as Observable<void>;
    }
  };


  /**
   * Get in sync with all the subqueries
   * @param subQueries A map of all the subqueries
   * @param parent The parent entity to attach the children to
   */
  const syncAllSubQueries = (subQueries: SubQueries<E>, parent: E) => {
    const obs = Object.keys(subQueries)
      .filter(key => key !== 'path' && key !== 'queryFn')
      .map((key: Extract<keyof SubQueries<E>, string>) => {
        const queryLike = getSubQuery<E, typeof key>(subQueries[key], parent);
        const child = { key, parentId: parent[this.idKey] };
        return syncSubQuery(queryLike, child);
      });
    return combineLatest(obs);
  };


  ////////////////
  // MAIN QUERY //
  ////////////////

  /** Listen on action with child queries */
  const fromActionWithChild = (
    actions: DocumentChangeAction<E>[],
    mainQuery: Query<E>,
    subscriptions: SubscriptionMap) => {

    for (const action of actions) {
      const id = action.payload.doc.id;
      const data = action.payload.doc.data();

      switch (action.type) {
        case 'added': {
          const entity = { [this.idKey]: id, ...data };
          this['store'].upsert(id, entity);
          subscriptions[id] = syncAllSubQueries(mainQuery as SubQueries<E>, entity).subscribe();
          break;
        }
        case 'removed': {
          this['store'].remove(id);
          subscriptions[id].unsubscribe();
          delete subscriptions[id];
          break;
        }
        case 'modified': {
          this['store'].update(id, data);
        }
      }
    }
  };

  const { path, queryFn } = query;
  if (isDocPath(path)) {
    const { id } = this['getIdAndPath']({path});
    let subscription: Subscription;
    return this['db'].doc<E>(path).valueChanges().pipe(
      tap(entity => {
        this['store'].upsert(id, {id, ...entity} as E);
        if (!subscription) { // Subscribe only the first time
          subscription = syncAllSubQueries(query as SubQueries<E>, entity).subscribe();
        }
      }),
      // Stop subscription
      finalize(() => subscription.unsubscribe())
    );
  } else {
    const subscriptions: SubscriptionMap = {};
    return this['db'].collection<E>(path, queryFn)
      .stateChanges()
      .pipe(
        withTransaction(actions => fromActionWithChild(actions, query, subscriptions)),
        // Stop all subscriptions
        finalize(() => Object.keys(subscriptions).forEach(id => {
          subscriptions[id].unsubscribe();
          delete subscriptions[id];
        }))
      ) as Observable<void>;
  }
}
