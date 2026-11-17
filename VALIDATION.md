# Validation

Run the automated checks with:

```bash
npm test
npm run migrate-check
python python/test_actions_schema.py
python python/test_voice_live.py
python python/test_provider_config.py
python python/test_memory_store.py
```

Tests that exercise Discord actions use mocks; they do not validate a live bot login, real server permissions, or provider behavior. Test in a private server before enabling actions in a production server. Back up the database and memory files before running migrations or upgrading.
