"""Unit tests for the VPS helper scripts. Run: python3 -m unittest discover -s test -p 'test_*.py'"""
import asyncio
import importlib.util
import json
import os
import runpy
import sys
import tempfile
import unittest

ROOT = os.path.join(os.path.dirname(__file__), "..", "vps-scripts")


def load_generate_codes():
    spec = importlib.util.spec_from_file_location("generate_codes", os.path.join(ROOT, "generate-codes.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def pkg(owner, name, version="1.0.0"):
    return {
        "owner": owner, "name": name, "source": "Thunderstore", "is_deprecated": False,
        "versions": [{"version_number": version, "full_name": f"{owner}-{name}-{version}", "dependencies": []}],
    }


class GenerateCodesTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.g = load_generate_codes()

    def test_normalize(self):
        self.assertEqual(self.g.normalize("Json-Dot_NET 2"), "jsondotnet2")
        self.assertEqual(self.g.normalize(None), "")

    def test_dependency_string_with_hyphens_in_name(self):
        self.assertEqual(self.g.parse_dependency_string("Owner-My-Mod-Name-1.2.3"), ("Owner", "My-Mod-Name", "1.2.3"))

    def test_uuid_codes_are_dashed(self):
        raw = "511a472a0b6f4e0e9a3e5f6a7b8c9d0e"
        self.assertEqual(self.g.normalize_uuid_code(raw), "511a472a-0b6f-4e0e-9a3e-5f6a7b8c9d0e")
        self.assertEqual(self.g.normalize_uuid_code("not-a-uuid"), "not-a-uuid")

    def test_version_picks_the_recorded_one(self):
        p = pkg("A", "B", "2.0.0")
        p["versions"].append({"version_number": "1.0.0", "full_name": "A-B-1.0.0", "dependencies": []})
        entry, fell_back, used, _ = self.g.build_mod_entry(p, "1.0.0")
        self.assertFalse(fell_back)
        self.assertEqual(used, "1.0.0")
        self.assertEqual(entry["version"], {"major": 1, "minor": 0, "patch": 0})
        _, fell_back, used, _ = self.g.build_mod_entry(p, "9.9.9")
        self.assertTrue(fell_back)
        self.assertEqual(used, "2.0.0")

    def test_jsondotnet_only_when_installed(self):
        packages = [pkg("denikson", "BepInExPack_Valheim", "5.4.2200"), pkg("ValheimModding", "JsonDotNET", "13.0.3")]
        names = lambda r: [x[0]["name"] for x in r]
        self.assertEqual(names(self.g.resolve_always_include(packages, [])), ["BepInExPack_Valheim"])
        self.assertEqual(names(self.g.resolve_always_include(packages, ["SomeMod-1.0.0"])), ["BepInExPack_Valheim"])
        self.assertEqual(names(self.g.resolve_always_include(packages, ["ValheimModding-JsonDotNET-13.0.3"])), ["BepInExPack_Valheim", "JsonDotNET"])
        # No installed list given (old callers): keep the previous behaviour and include both.
        self.assertEqual(names(self.g.resolve_always_include(packages)), ["BepInExPack_Valheim", "JsonDotNET"])


try:
    import discord  # noqa: F401
    HAVE_DISCORD = True
except ImportError:
    HAVE_DISCORD = False


@unittest.skipUnless(HAVE_DISCORD, "discord.py is not installed (pip install discord.py)")
class BotTests(unittest.TestCase):
    def setUp(self):
        import discord
        self.discord = discord
        self.tmp = tempfile.mkdtemp()
        self.yaml = os.path.join(self.tmp, "Mods.yaml")
        with open(self.yaml, "w") as f:
            f.write("x")
        self.worlds_file = os.path.join(self.tmp, "worlds.json")
        self.write_worlds([
            {"id": "main", "label": "Asgard", "profileName": "Asgard", "modsYaml": self.yaml, "pluginsDir": self.tmp},
            {"id": "w2", "label": "Second", "profileName": "Second", "modsYaml": os.path.join(self.tmp, "missing.yaml"), "pluginsDir": self.tmp},
        ])
        os.environ.update(DISCORD_BOT_TOKEN="x", DISCORD_ALLOWED_USER_IDS="111111111111111111", GENERATE_CODES_SCRIPT="/bin/true", BOT_WORLDS_FILE=self.worlds_file)
        discord.Client.run = lambda self_, token: None  # do not log in
        self.g = runpy.run_path(os.path.join(ROOT, "discord-codes-bot.py"))
        self.calls = []

        async def fake_run(world, mode, dry):
            self.calls.append((world["id"], mode, dry))
            return "PLAYER_CODE=abc-123\nADMIN_CODE=def-456\n", "", 0

        self.g["codes"].callback.__globals__["run_generate"] = fake_run

    def write_worlds(self, data):
        with open(self.worlds_file, "w") as f:
            json.dump(data, f)

    def interaction(self, uid=111111111111111111):
        log = []

        class Resp:
            async def send_message(s, m, ephemeral=False): log.append(("msg", m, ephemeral))
            async def defer(s, **k): log.append(("defer",))

        class Follow:
            async def send(s, m, ephemeral=False): log.append(("follow", m, ephemeral))

        class Chan:
            async def send(s, m): log.append(("chan", m))

        i = type("I", (), {})()
        i.user = type("U", (), {"id": uid, "_roles": [], "roles": []})()
        i.response, i.followup, i.channel, i.log = Resp(), Follow(), Chan(), log
        return i

    def run_cmd(self, i, mode="player", **kw):
        choice = self.discord.app_commands.Choice(name=mode, value=mode)
        asyncio.run(self.g["codes"].callback(i, choice, **kw))

    def test_refuses_users_who_are_not_allowed(self):
        i = self.interaction(222222222222222222)
        self.run_cmd(i)
        self.assertIn("not allowed", i.log[0][1])
        self.assertEqual(self.calls, [])

    def test_defaults_to_the_first_world_and_keeps_codes_private(self):
        i = self.interaction()
        self.run_cmd(i, "both")
        self.assertEqual(self.calls[-1][0], "main")
        self.assertIn("Admin code", i.log[-1][1])
        self.assertTrue(i.log[-1][2], "the reply with the admin code must be ephemeral")

    def test_unknown_world_and_missing_mods_yaml(self):
        i = self.interaction()
        self.run_cmd(i, world="nonsense")
        self.assertIn("Unknown world", i.log[0][1])
        i = self.interaction()
        self.run_cmd(i, world="w2")
        self.assertIn("no Mods.yaml", i.log[0][1])
        self.assertEqual(self.calls, [])

    def test_public_post_has_the_player_code_only(self):
        i = self.interaction()
        self.run_cmd(i, public=True)
        posts = [l[1] for l in i.log if l[0] == "chan"]
        self.assertEqual(len(posts), 1)
        self.assertIn("abc-123", posts[0])
        self.assertNotIn("def-456", posts[0])
        self.assertIn("Asgard", posts[0])

    def test_autocomplete_filters_and_hides_from_strangers(self):
        res = asyncio.run(self.g["world_autocomplete"](self.interaction(), "sec"))
        self.assertEqual([c.value for c in res], ["w2"])
        self.assertEqual(asyncio.run(self.g["world_autocomplete"](self.interaction(222222222222222222), "")), [])

    def test_empty_world_list(self):
        self.write_worlds([])
        i = self.interaction()
        self.run_cmd(i)
        self.assertIn("No worlds", i.log[0][1])


if __name__ == "__main__":
    unittest.main()
