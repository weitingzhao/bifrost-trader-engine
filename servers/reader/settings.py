"""Settings: IB config, Flex config, key_value groups and key_value.
Module-level functions re-exported from legacy until full migration in step 7."""

from servers.reader._legacy import (
    create_key_value_group,
    delete_key_value,
    delete_key_value_group,
    set_key_value,
    update_key_value_group,
    write_flex_config,
    write_ib_config,
)

__all__ = [
    "write_ib_config",
    "write_flex_config",
    "set_key_value",
    "delete_key_value",
    "create_key_value_group",
    "update_key_value_group",
    "delete_key_value_group",
]
