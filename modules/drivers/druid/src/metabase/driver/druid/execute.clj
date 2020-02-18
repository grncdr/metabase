(ns metabase.driver.druid.execute
  (:require [cheshire.core :as json]
            [clojure.math.numeric-tower :as math]
            [java-time :as t]
            [metabase.driver.druid.query-processor :as druid.qp]
            [metabase.query-processor
             [store :as qp.store]
             [timezone :as qp.timezone]]
            [metabase.query-processor.middleware.annotate :as annotate]
            [metabase.util :as u]
            [metabase.util.date-2 :as u.date]
            [schema.core :as s]))

(defn- resolve-timezone
  "Returns the timezone object (either report-timezone or JVM timezone). Returns nil if the timezone is UTC as the
  timestamps from Druid are already in UTC and don't need to be converted"
  [_]
  (when-not (= (t/zone-id (qp.timezone/results-timezone-id)) (t/zone-id "UTC"))
    (qp.timezone/results-timezone-id)))

(defmulti ^:private post-process
  "Do appropriate post-processing on the results of a query based on the `query-type`."
  {:arglists '([query-type projections timezone-and-middleware-settings results])}
  (fn [query-type _ _ _]
    query-type))

(defmethod post-process ::druid.qp/select
  [_ projections {:keys [middleware]} [{{:keys [events]} :result} first-result]]
  {:projections projections
   :results     (for [event (map :event events)]
                  (update event :timestamp u.date/parse))})

(defmethod post-process ::druid.qp/total
  [_ projections _ results]
  {:projections projections
   :results     (map :result results)})

(defmethod post-process ::druid.qp/topN
  [_ projections {:keys [middleware]} results]
  {:projections projections
   :results     (let [results (-> results first :result)]
                  (if (:format-rows? middleware true)
                    results
                    (map #(u/update-when % :timestamp u.date/parse) results)))})

(defmethod post-process ::druid.qp/groupBy
  [_ projections {:keys [middleware]} results]
  {:projections projections
   :results     (if (:format-rows? middleware true)
                  (map :event results)
                  (map (comp #(u/update-when % :timestamp u.date/parse)
                             :event)
                       results))})

(defmethod post-process ::druid.qp/timeseries
  [_ projections {:keys [middleware]} results]
  {:projections (conj projections :timestamp)
   :results     (let [ts-getter (if (:format-rows? middleware true)
                                  :timestamp
                                  (comp u.date/parse :timestamp))]
                  (for [event results]
                    (merge {:timestamp (ts-getter event)} (:result event))))})


(s/defn ^:private col-names->getter-fns :- [(s/cond-pre s/Keyword (s/pred fn?))]
  "Given a sequence of `columns` keywords, return a sequence of appropriate getter functions to get values from a single
  result row. Normally, these are just the keyword column names themselves, but for `:timestamp___int`, we'll also
  parse the result as an integer (for further explanation, see the docstring for
  `units-that-need-post-processing-int-parsing`). We also round `:distinct___count` in order to return an integer
  since Druid returns the approximate floating point value for cardinality queries (See Druid documentation regarding
  cardinality and HLL)."
  [columns :- [s/Keyword]]
  (for [k columns]
    (case (keyword k)
      :distinct___count (comp math/round k)
      :timestamp___int  (comp (fn [^String s]
                                (when (some? s)
                                  (Integer/parseInt s)))
                              k)
      k)))

(defn- result-metadata [col-names]
  ;; rename any occurances of `:timestamp___int` to `:timestamp` in the results so the user doesn't know about
  ;; our behind-the-scenes conversion and apply any other post-processing on the value such as parsing some
  ;; units to int and rounding up approximate cardinality values.
  (let [fixed-col-names (for [col-name col-names]
                          (case col-name
                            :timestamp___int  :timestamp
                            :distinct___count :count
                            col-name))]
    {:cols (vec (for [col-name fixed-col-names]
                  {:name (u/qualified-name col-name)}))}))

(defn- result-rows [{rows :results} col-names]
  (let [getters (vec (col-names->getter-fns col-names))]
    (for [row rows]
      (mapv row getters))))

(defn- remove-bonus-keys
  "Remove keys that start with `___` from the results -- they were temporary, and we don't want to return them."
  [columns]
  (vec (remove #(re-find #"^___" (name %)) columns)))

(defn- reduce-results
  [{{:keys [query query-type mbql?]} :native, :as outer-query} {:keys [projections], :as result} respond]
  (let [col-names          (if mbql?
                             (->> projections
                                  remove-bonus-keys
                                  vec)
                             (-> result :results first keys))
        metadata           (result-metadata col-names)
        annotate-col-names (map (comp keyword :name) (annotate/column-info* outer-query metadata))]
    (respond metadata (result-rows result annotate-col-names))))

(defn execute-reducible-query
  "Execute a query for a Druid DB."
  [execute*
   {database-id                                  :database
    {:keys [query query-type mbql? projections]} :native
    middleware                                   :middleware
    :as                                          mbql-query}
   respond]
  {:pre [query]}
  (let [details    (:details (qp.store/database))
        query      (if (string? query)
                     (json/parse-string query keyword)
                     query)
        query-type (or query-type
                       (keyword (namespace ::druid.qp/query) (name (:queryType query))))
        result     (->> query
                        (execute* details)
                        (post-process query-type projections
                                      {:timezone   (resolve-timezone mbql-query)
                                       :middleware middleware}))]
    (reduce-results mbql-query result respond)))
