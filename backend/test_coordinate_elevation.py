import unittest
from pydantic import ValidationError
from backend.main import SourceIn, ReceiverIn, _object_ground, ReceiverPreviewRequest, receiver_preview

class CoordinateElevationTests(unittest.TestCase):
    def test_absolute_terrain_is_separate_from_height(self):
        source=SourceIn(id='s', name='GPS', lat=-33.45, lon=-70.64, height_m=2, ground_elevation_m=520)
        self.assertEqual(_object_ground(source,None,-33.45,-70.64),520)
        self.assertEqual(source.height_m,2)
        self.assertEqual(_object_ground(source.model_copy(update={'ground_elevation_m':None}),None,-33.45,-70.64),0)
        self.assertEqual(_object_ground(source.model_copy(update={'ground_elevation_m':0}),None,-33.45,-70.64),0)
    def test_reject_nonfinite_elevation(self):
        with self.assertRaises(ValidationError):
            ReceiverIn(id='r',name='GPS',lat=0,lon=0,ground_elevation_m=float('nan'))
