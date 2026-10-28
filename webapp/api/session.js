const { passcodeHash, passcodeOk } = require("./_lib");

module.exports = async (req, res) => {
  const gate = !!passcodeHash();
  res.status(200).json({
    gate,
    authed: passcodeOk(req),
    modelKey: !!process.env.MODEL_API_KEY,
  });
};
