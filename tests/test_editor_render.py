import unittest
import test_app
from app import render_markdown

class EditorRenderTests(unittest.TestCase):
 def test_merged_table_cells_keep_safe_spans(self):
  html=render_markdown('<table><tr><td colspan="2" rowspan="3">合并单元格</td><th colspan="4">行程</th></tr></table>')
  self.assertIn('colspan="2"',html);self.assertIn('rowspan="3"',html);self.assertIn('colspan="4"',html)
 def test_editor_table_does_not_allow_scripts_styles_or_invalid_spans(self):
  for value in ('0','-1','101','nan','2 onclick=alert(1)','9'*5000):
   html=render_markdown('<table><tr><td colspan="'+value+'" onclick="alert(1)" style="position:fixed">内容</td></tr></table>')
   self.assertNotIn('colspan=',html);self.assertNotIn('onclick=',html);self.assertNotIn('style=',html)
