import {
  fieldRefForColumn,
  syncTableColumnsToQuery,
  findColumnForColumnSetting,
} from "metabase/lib/dataset";

import { ORDERS, PRODUCTS } from "__support__/sample_dataset_fixture";

const FIELD_COLUMN = { id: 1 };
const FK_COLUMN = { id: 1, fk_field_id: 2 };
const EXPRESSION_COLUMN = { expression_name: "foo" };
const AGGREGATION_COLUMN = { source: "aggregation" };

describe("metabase/util/dataset", () => {
  describe("fieldRefForColumn", () => {
    it('should return `["field-id", 1]` for a normal column', () => {
      expect(fieldRefForColumn(FIELD_COLUMN)).toEqual(["field-id", 1]);
    });
    it('should return `["fk->", ["field-id", 2], ["field-id", 1]]` for a fk column', () => {
      expect(fieldRefForColumn(FK_COLUMN)).toEqual([
        "fk->",
        ["field-id", 2],
        ["field-id", 1],
      ]);
    });
    it('should return `["expression", 2, 1]` for a fk column', () => {
      expect(fieldRefForColumn(EXPRESSION_COLUMN)).toEqual([
        "expression",
        "foo",
      ]);
    });

    describe("aggregation column", () => {
      // this is an unfortunate effect of the backend not returning enough information to determine the aggregation index from the column
      it("should return `null` for aggregation column if list of columns was provided", () => {
        expect(fieldRefForColumn(AGGREGATION_COLUMN)).toEqual(null);
      });
      it('should return `["aggregation", 0]` for aggregation column if list of columns was provided', () => {
        expect(
          fieldRefForColumn(AGGREGATION_COLUMN, [AGGREGATION_COLUMN]),
        ).toEqual(["aggregation", 0]);
      });
      it('should return `["aggregation", 1]` for second aggregation column if list of columns was provided', () => {
        expect(
          fieldRefForColumn(AGGREGATION_COLUMN, [
            { source: "aggregation" },
            AGGREGATION_COLUMN,
          ]),
        ).toEqual(["aggregation", 1]);
      });
    });

    // NOTE: sometimes id is an MBQL clause itself, e.x. nested queries
    it("should return `id` if is an MBQL clause", () => {
      expect(fieldRefForColumn({ id: ["field-id", 3] })).toEqual([
        "field-id",
        3,
      ]);
    });
  });

  describe("syncTableColumnsToQuery", () => {
    it("should not modify `fields` if no `table.columns` setting preset", () => {
      const question = syncTableColumnsToQuery(
        ORDERS.query({
          fields: [["field-id", ORDERS.TOTAL.id]],
        }).question(),
      );
      expect(question.query().query()).toEqual({
        "source-table": ORDERS.id,
        fields: [["field-id", ORDERS.TOTAL.id]],
      });
    });
    it("should sync included `table.columns` by name", () => {
      const question = syncTableColumnsToQuery(
        ORDERS.query()
          .question()
          .setSettings({
            "table.columns": [
              {
                name: "TOTAL",
                enabled: true,
              },
            ],
          }),
      );
      expect(question.query().query()).toEqual({
        "source-table": ORDERS.id,
        fields: [["field-id", ORDERS.TOTAL.id]],
      });
    });
    it("should sync included `table.columns` by fieldRef", () => {
      const question = syncTableColumnsToQuery(
        ORDERS.query()
          .question()
          .setSettings({
            "table.columns": [
              {
                fieldRef: ["field-id", ORDERS.TOTAL.id],
                enabled: true,
              },
            ],
          }),
      );
      expect(question.query().query()).toEqual({
        "source-table": ORDERS.id,
        fields: [["field-id", ORDERS.TOTAL.id]],
      });
    });
    it("should not modify columns if all default columns are enabled", () => {
      const query = ORDERS.query();
      const question = syncTableColumnsToQuery(
        query.question().setSettings({
          "table.columns": query.columnNames().map(name => ({
            name,
            enabled: true,
          })),
        }),
      );
      expect(question.query().query()).toEqual({
        "source-table": ORDERS.id,
      });
    });

    describe("with joins", () => {
      it("should sync included `table.columns` by name to join clauses", () => {
        const question = syncTableColumnsToQuery(
          ORDERS.query()
            .join({
              alias: "products",
              fields: "all",
              "source-table": PRODUCTS.id,
            })
            .question()
            .setSettings({
              "table.columns": [
                {
                  name: "TOTAL",
                  enabled: true,
                },
                {
                  name: "PRICE",
                  enabled: true,
                },
              ],
            }),
        );
        expect(question.query().query()).toEqual({
          "source-table": ORDERS.id,
          joins: [
            {
              alias: "products",
              "source-table": PRODUCTS.id,
              fields: [
                ["joined-field", "products", ["field-id", PRODUCTS.PRICE.id]],
              ],
            },
          ],
          fields: [["field-id", ORDERS.TOTAL.id]],
        });
      });
      it("should sync included `table.columns` by fieldRef to join clauses", () => {
        const question = syncTableColumnsToQuery(
          ORDERS.query()
            .join({
              alias: "products",
              fields: "all",
              "source-table": PRODUCTS.id,
            })
            .question()
            .setSettings({
              "table.columns": [
                {
                  fieldRef: ["field-id", ORDERS.TOTAL.id],
                  enabled: true,
                },
                {
                  fieldRef: [
                    "joined-field",
                    "products",
                    ["field-id", PRODUCTS.PRICE.id],
                  ],
                  enabled: true,
                },
              ],
            }),
        );
        expect(question.query().query()).toEqual({
          "source-table": ORDERS.id,
          joins: [
            {
              alias: "products",
              "source-table": PRODUCTS.id,
              fields: [
                ["joined-field", "products", ["field-id", PRODUCTS.PRICE.id]],
              ],
            },
          ],
          fields: [["field-id", ORDERS.TOTAL.id]],
        });
      });
    });
  });

  describe("findColumnForColumnSetting", () => {
    const columns = [
      { name: "bar", id: 42 },
      { name: "foo", id: 1, fk_field_id: 2 },
      { name: "baz", id: 43 },
    ];
    it("should find column with name", () => {
      const column = findColumnForColumnSetting(columns, { name: "foo" });
      expect(column).toBe(columns[1]);
    });
    it("should find column with normalized fieldRef", () => {
      const column = findColumnForColumnSetting(columns, {
        fieldRef: ["fk->", ["field-id", 2], ["field-id", 1]],
      });
      expect(column).toBe(columns[1]);
    });
    it("should find column with non-normalized fieldRef", () => {
      const column = findColumnForColumnSetting(columns, {
        fieldRef: ["fk->", 2, 1], // deprecated
      });
      expect(column).toBe(columns[1]);
    });
  });
});
