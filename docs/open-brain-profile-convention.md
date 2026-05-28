# Open Brain — User Profile Convention

User-profile data (location, name, work hours, preferred timezone, etc.)
lives in the same `public.thoughts` table as everything else, marked by
a stable metadata shape that downstream services query.

## Why one table

Profile data doesn't need its own table. It's small, it changes
occasionally, and treating it as a thought means:

- The same capture path (`mcp__openbrain__capture_thought`) works
- The same retention / dedup / wiki orphan-sweep works
- Future agents that browse the brain see profile context alongside
  other facts about the user

The convention below is what makes the data *findable* — services
filter by `metadata.type = 'profile_field'` and the most recent entry
for a given `field_name` wins.

## Metadata shape

```json
{
  "type": "profile_field",
  "field_name": "address",
  "source": "manual"
}
```

The thought's `content` column holds the **value** of the field as a
free-form string. The metadata identifies *what kind of field* it is.

Examples:

| `field_name`        | Example `content`                                | Used by                  |
|---------------------|--------------------------------------------------|--------------------------|
| `address`           | `Toronto, ON, Canada`                            | weather lookup           |
| `name`              | `Jane Doe`                                       | future digest greeting   |
| `timezone`          | `America/Toronto`                                | scheduled-job alignment  |
| `work_hours`        | `09:00–17:30 weekdays, no weekends`              | calendar/digest context  |
| `preferred_email`   | `jane@example.com`                               | digest recipient default |
| `morning_routine`   | `gym 06:00–07:00, then standup 09:30`            | calendar considerations  |

`field_name` is a flat string (no nesting). Pick one canonical name per
piece of information; downstream services query by exact match.

## How to update a profile field

Capture a new thought with the metadata above and the new value as
content. The "latest by `created_at`" wins; older entries become archive.
There is no in-place update — you just append.

**Via Claude Code (recommended):**

```
Remember my address is "Toronto, ON, Canada" — capture it as my
profile address in Open Brain.
```

Claude Code routes this to `mcp__openbrain__capture_thought` with
`{ type: "profile_field", field_name: "address", source: "manual" }`.

**Via direct MCP / SQL (advanced):**

```sql
INSERT INTO thoughts (content, metadata)
VALUES (
  'Toronto, ON, Canada',
  '{"type":"profile_field","field_name":"address","source":"manual"}'::jsonb
);
```

## How services query a profile field

PostgREST:

```
GET /rest/v1/thoughts
  ?select=content,created_at
  &metadata->>type=eq.profile_field
  &metadata->>field_name=eq.address
  &order=created_at.desc
  &limit=1
```

Raw SQL:

```sql
SELECT content
FROM thoughts
WHERE metadata->>'type' = 'profile_field'
  AND metadata->>'field_name' = 'address'
ORDER BY created_at DESC
LIMIT 1;
```

Services that need profile data should treat the result as a string and
gracefully degrade if no row exists (e.g. the weather section skips
itself rather than failing the whole digest).

## Privacy

Profile fields are no more sensitive than other thoughts in Open Brain.
The `openbrain-gateway` cloud-share enforcement applies the same way:
profile fields without `metadata.share="cloud"` stay local. Default is
local-only.
