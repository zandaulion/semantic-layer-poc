/**
 * Validation for a catalog before it reaches Elasticsearch.
 *
 * Every field named here is one the application actually reads. The bundled
 * fixture carries a good deal more -- ordinal positions, primary key flags,
 * design provenance -- and none of it is required, because requiring fields
 * nothing consumes would make a catalog harder to produce for no gain.
 *
 * The failure this exists to prevent is the quiet one. A catalog missing
 * `grain` still indexes, still searches, and still produces drafts; they are
 * just worse, in a way that looks like the model being poor at its job. Saying
 * so at ingestion time, against the file, costs nothing and points at the
 * actual cause.
 */

/** Fields whose absence makes a table unusable rather than merely thin. */
const REQUIRED_TABLE_FIELDS = ['table_name', 'domain', 'grain', 'table_type'];
const REQUIRED_COLUMN_FIELDS = ['column_name', 'data_type'];

/** Read into search_text, so absence costs recall rather than correctness. */
const RETRIEVAL_FIELDS = ['description'];

const isText = (value) => typeof value === 'string' && value.trim().length > 0;

/**
 * @param {unknown} catalog
 * @returns {{ errors: string[], warnings: string[], summary: object }}
 */
export function validateCatalog(catalog) {
  const errors = [];
  const warnings = [];

  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) {
    return { errors: ['The catalog must be a JSON object.'], warnings, summary: {} };
  }
  if (!Array.isArray(catalog.tables) || catalog.tables.length === 0) {
    return { errors: ['The catalog must have a non-empty "tables" array.'], warnings, summary: {} };
  }
  if (catalog.schema_name !== undefined && !isText(catalog.schema_name)) {
    errors.push('"schema_name" must be a non-empty string when present.');
  }

  const seen = new Map();
  let columnCount = 0;
  let missingDescriptions = 0;

  catalog.tables.forEach((table, index) => {
    const where = isText(table?.table_name) ? `table "${table.table_name}"` : `tables[${index}]`;
    if (!table || typeof table !== 'object') {
      errors.push(`${where}: must be an object.`);
      return;
    }
    for (const field of REQUIRED_TABLE_FIELDS) {
      if (!isText(table[field])) errors.push(`${where}: "${field}" is required and must be a non-empty string.`);
    }
    if (isText(table.table_name)) {
      if (seen.has(table.table_name)) {
        errors.push(`${where}: duplicated at tables[${seen.get(table.table_name)}] and tables[${index}]; `
          + 'table_name is the document identity, so a duplicate silently overwrites the earlier one.');
      } else {
        seen.set(table.table_name, index);
      }
    }

    if (!Array.isArray(table.columns) || table.columns.length === 0) {
      errors.push(`${where}: "columns" is required and must not be empty.`);
    } else {
      const columnNames = new Set();
      table.columns.forEach((column, columnIndex) => {
        columnCount += 1;
        const at = `${where}, columns[${columnIndex}]`;
        if (!column || typeof column !== 'object') {
          errors.push(`${at}: must be an object.`);
          return;
        }
        for (const field of REQUIRED_COLUMN_FIELDS) {
          if (!isText(column[field])) errors.push(`${at}: "${field}" is required and must be a non-empty string.`);
        }
        if (isText(column.column_name)) {
          if (columnNames.has(column.column_name)) errors.push(`${at}: duplicate column "${column.column_name}".`);
          columnNames.add(column.column_name);
        }
        if (RETRIEVAL_FIELDS.some((field) => !isText(column[field]))) missingDescriptions += 1;
      });
    }

    if (table.relationships !== undefined && !Array.isArray(table.relationships)) {
      errors.push(`${where}: "relationships" must be an array when present.`);
    }
  });

  // Relationship targets are checked after every table is known, so forward
  // references to a table defined later in the file are not reported as broken.
  let relationshipCount = 0;
  for (const table of catalog.tables) {
    if (!Array.isArray(table?.relationships)) continue;
    table.relationships.forEach((relation, index) => {
      relationshipCount += 1;
      const at = `table "${table.table_name}", relationships[${index}]`;
      for (const field of ['from_table', 'from_column', 'to_table', 'to_column']) {
        if (!isText(relation?.[field])) errors.push(`${at}: "${field}" is required.`);
      }
      // A join offered to the model that points nowhere is worse than no join
      // offered at all: it reads as approved metadata.
      if (isText(relation?.to_table) && !seen.has(relation.to_table)) {
        errors.push(`${at}: target table "${relation.to_table}" is not in this catalog.`);
      }
      if (isText(relation?.from_table) && relation.from_table !== table.table_name) {
        warnings.push(`${at}: "from_table" is "${relation.from_table}" but the relationship is declared on `
          + `"${table.table_name}"; the renderer trusts the field, not the placement.`);
      }
    });
  }

  if (missingDescriptions) {
    warnings.push(`${missingDescriptions} of ${columnCount} columns have no description. Descriptions are `
      + 'concatenated into search_text, so questions that do not use your column names will retrieve less.');
  }

  return {
    errors,
    warnings,
    summary: {
      schema_name: catalog.schema_name ?? '(defaults to bank_dwh)',
      tables: catalog.tables.length,
      columns: columnCount,
      relationships: relationshipCount,
      domains: [...new Set(catalog.tables.map((table) => table?.domain).filter(isText))].sort(),
    },
  };
}
