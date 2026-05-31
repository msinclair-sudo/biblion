# biblion test suite

```bash
# install once
pip install pytest

# run everything
pytest

# run just one category
pytest -m unit          # 103 tests, <2s
pytest -m integration   # 9 tests, ~9s, spawns real subprocess workers
pytest -m perf          # 15 tests, ~1s, asserts query plans + scale

# skip slow ones
pytest -m "not slow"
```

## Requirements

* **Redis** running at `redis://localhost:6379`. Tests use **db=15** (production uses db=0). Override with `BIBLION_TEST_REDIS_URL`.
* **No network access** to OpenAlex/S2/NCBI is needed — every API client has a fake in `tests/support/fake_clients.py`.

## Layout

```
tests/
├── conftest.py                 # shared fixtures: tmp_db_path, cache, etc.
├── unit/                       # in-process, ms each
├── integration/                # real subprocess workers (worker_runner fixture)
├── perf/                       # query plans + scale-up budgets
└── support/                    # helpers (fake clients, worker spawner)
```

## Adding tests

Every fixture in `conftest.py` is auto-discoverable. The most common patterns:

```python
def test_thing(insert_paper, count_rows):
    pid = insert_paper(doi='10.1/a', title='Test')
    assert count_rows('papers') == 1

@pytest.mark.integration
def test_subprocess_thing(worker_runner, tmp_db_path, redis_url, cache):
    worker = worker_runner.spawn_writer(tmp_db_path, redis_url)
    cache.push_paper(...)
    worker_runner.wait_for(lambda: ..., timeout=10)
```

When you add a new producer module, the parametrized index-coverage test in `tests/perf/test_index_coverage.py` will automatically check that its candidate SQL uses an index — no extra test needed.
